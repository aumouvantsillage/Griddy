
// Shorthand
if (typeof(Cc) == "undefined")
  var Cc = Components.classes;
if (typeof(Ci) == "undefined")
  var Ci = Components.interfaces;
if (typeof(Cu) == "undefined")
  var Cu = Components.utils;
if (typeof(Cr) == "undefined")
  var Cr = Components.results;

// Pseudo-Thread (Peter van Hardenberg)
function pseudoThread(gen) {
  var thisGen = this;
  var callback = {
    observe: function(subject, topic, data) {
      switch (topic) {
        case "timer-callback":
          try {
            gen.next();
          } catch (e if e instanceof StopIteration) {
            gen.close();
            thisGen.threadTimer.cancel();
          } catch (e) {
            gen.close();
            thisGen.threadTimer.cancel();
            Cu.reportError(e);
        };
      }
    }
  }
  this.threadTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  this.threadTimer.init(callback, 0, Ci.nsITimer.TYPE_REPEATING_SLACK);
}

/**
 * Media Page Controller
 *
 * In order to display the contents of a library or list, pages
 * must provide a "window.mediaPage" object implementing
 * the Songbird sbIMediaPage interface. This interface allows
 * the rest of Songbird to talk to the page without knowledge 
 * of what the page looks like.
 *
 * In this particular page most functionality is simply 
 * delegated to the sb-playlist widget.
 */
window.mediaPage = {
    
  _griddy: null,
  _defaultAlbumSize: 100, // FIXME Redundant with prefs.js
  _stringBundle: null,
  _albumFilter: null,
  _refreshing: false,
  _restartRefresh: false,
  _sortPropertyArray: null,

  get preferredAlbumSize() {
    var albumSizePref = Application.prefs.get("extensions.griddy.albumSize");
    if(albumSizePref == null || albumSizePref.value <= 0)
      return this._defaultAlbumSize;
    else
      return albumSizePref.value;
  },

  _prefsObserver: {
    register: function() {
      var prefService = Cc["@mozilla.org/preferences-service;1"]
                                  .getService(Ci.nsIPrefService);
      this._branch = prefService.getBranch("extensions.griddy.");
      this._branch.QueryInterface(Ci.nsIPrefBranch2);
      this._branch.addObserver("", this, false);
    },

    unregister: function() {
      if(!this._branch) return;
      this._branch.removeObserver("", this);
    },

    observe: function(aSubject, aTopic, aData) {
      if(aTopic != "nsPref:changed") return;
      switch(aData) {
        case "albumSize":
          window.mediaPage._griddy.updateAlbumsPerRow();
          window.mediaPage._griddy.updateAlbumSize();
          break;
      }
    }
  },

  // The sbIMediaListView that this page is to display
  _mediaListView: null,
    
  // The sb-playlist XBL binding
  _playlist: null, 
  
  /** 
   * Gets the sbIMediaListView that this page is displaying
   */
  get mediaListView()  {
    return this._mediaListView;
  },
  
  /** 
   * Set the sbIMediaListView that this page is to display.
   * Called in the capturing phase of window load by the Songbird browser.
   * Note that to simplify page creation mediaListView may only be set once.
   */
  set mediaListView(value) {
    if (!this._mediaListView) {
      this._mediaListView = value; //.mediaList.createView();
    } else {
      throw new Error("mediaListView may only be set once.  Please reload the page");
    }
  },
    
  attachListeners: function() {
    this._mediaListView.addListener(this);
    this._prefsObserver.register();
    window.addEventListener('resize',function(event){window.mediaPage._griddy.updateAlbumsPerRow();},false);
  },

  detachListeners: function() {
    this._mediaListView.removeListener(this);
    this._prefsObserver.unregister();
    window.removeEventListener('resize',function(event){window.mediaPage._griddy.updateAlbumsPerRow();},false);
  },

  /** 
   * Called when the page finishes loading.  
   * By this time window.mediaPage.mediaListView should have 
   * been externally set.  
   */
  onLoad:  function(e) {
    // Make sure we have the javascript modules we're going to use
    if (!window.SBProperties) 
      Cu.import("resource://app/jsmodules/sbProperties.jsm");
    if (!window.LibraryUtils) 
      Cu.import("resource://app/jsmodules/sbLibraryUtils.jsm");
    if (!window.kPlaylistCommands) 
      Cu.import("resource://app/jsmodules/kPlaylistCommands.jsm");
    
    if (!this._mediaListView) {
      Cu.reportError("Media Page did not receive a mediaListView before the onload event!");
      return;
    } 
    
    this._playlist = document.getElementById("playlist");

    // Get playlist commands (context menu, keyboard shortcuts, toolbar)
    // Note: playlist commands currently depend on the playlist widget.
    
    // Set up the playlist widget
    this._playlist.bind(this._mediaListView,
      Cc["@songbirdnest.com/Songbird/PlaylistCommandsManager;1"].createInstance(Ci.sbIPlaylistCommandsManager)
        .request(kPlaylistCommands.MEDIAITEM_DEFAULT)
    );
    
    // Griddy-specific initializations
    this._griddy = document.getElementById("griddy");
    this._stringBundle = document.getElementById("griddy-strings");

    // Sort playlist by artist
    // FIXME: cascade filter does not take sorting into account
    this._sortPropertyArray = SBProperties.createArray([
      [SBProperties.artistName, "a"] // FIXME Should be album artist
    ]);

    this._mediaListView.setSort(this._sortPropertyArray);
    this._albumFilter = this._mediaListView.cascadeFilterSet.appendFilter(SBProperties.albumName);
    this.attachListeners();

    this.initDisplay();
  },
    
  /** 
   * Called as the window is about to unload
   */
  onUnload:  function(e) {
    this.detachListeners();
    if (this._playlist) {
      this._playlist.destroy();
      this._playlist = null;
    }
  },
  
  /** 
   * Show/highlight the MediaItem at the given MediaListView index.
   * Called by the Find Current Track button.
   */
  highlightItem: function(aIndex) {
    this._playlist.highlightItem(aIndex);
  },
  
  /** 
   * Called when something is dragged over the tabbrowser tab for this window
   */
  canDrop: function(aEvent, aSession) {
    return this._playlist.canDrop(aEvent, aSession);
  },
  
  /** 
   * Called when something is dropped on the tabbrowser tab for this window
   */
  onDrop: function(aEvent, aSession) {
    return this._playlist.
        _dropOnTree(this._playlist.mediaListView.length,
                Ci.sbIMediaListViewTreeViewObserver.DROP_AFTER);
  },

  initDisplay: function() {
    if(this._refreshing)
      this._restartRefresh = true;
    else
      pseudoThread(this.collectAlbums());
  },

  getAlbumNameForMediaItem: function(anItem) {
    var albumName = anItem.getProperty(SBProperties.albumName);
    if(albumName)
      albumName = albumName.replace(/^\s+|\s+$/g, '');
    if(!albumName || albumName == '')
      albumName = this._stringBundle.getString('griddy.mediapage.tooltip.noAlbumName');
    return albumName;
  },

  getAlbumArtURLForMediaItem: function(anItem) {
    var albumArtURL = anItem.getProperty(SBProperties.primaryImageURL);
    if(albumArtURL == null || albumArtURL == "") {
      if(this._albumArtService)
        albumArtURL = this._albumArtService.getAlbumArtWork(anItem, true);
      else
        albumArtURL = "chrome://songbird/skin/album-art/default-cover.png";
    }
    return albumArtURL;
  },

  getAlbumArtistForMediaItem: function(anItem) {
    var artistName = anItem.getProperty(SBProperties.artistName);
    if(artistName)
      artistName = artistName.replace(/^\s+|\s+$/g, '');
    if(!artistName || artistName == '')
      artistName = this._stringBundle.getString('griddy.mediapage.tooltip.noArtist');
    return artistName;
  },

  // This function is built as a generator, to be called from a pseudo-thread
  collectAlbums: function() {
    // Notify event handlers that the page is being refreshed
    this._refreshing = true;

    do {
      // Reset the flag from event handlers
      this._restartRefresh = false;

      // Empty the grid view
      this._griddy.clean();
      yield;

      // Get current page height for splitter relocation (see end of function)
      var pageHeight = parseInt(document.getElementById('griddy-media-page').boxObject.height);

      // Collect all albums from the media list
      var filterSet = this._mediaListView.cascadeFilterSet;
      var albumCount = filterSet.getValueCount(this._albumFilter);

      for (var al = 0; al < albumCount; al++) {
        var albumName = filterSet.getValueAt(this._albumFilter, al);

        // FIXME: album artist is assumed to be the artist of the first track
        var mediaItem = this.mediaListView.mediaList.getItemsByProperty(SBProperties.albumName, albumName).queryElementAt(0, Ci.sbIMediaItem);
        this._griddy.addAlbum(
          this.getAlbumNameForMediaItem(mediaItem), // albumName does not contain the complete name
          this.getAlbumArtistForMediaItem(mediaItem),
          this.getAlbumArtURLForMediaItem(mediaItem)
        );
 
        // Allow the UI to interleave page rendering with album collecting
        yield al;

        // If an event handler asked for a refresh, stop collecting albums
        if(this._restartRefresh)
          break;
      }

      // This loop will run as long as event handlers ask for a refresh
    } while(this._restartRefresh);

    // Force splitter location
    var splitter = document.getElementById('griddy-splitter');
    if(splitter.getResizeBefore().boxObject.height > pageHeight * 9 / 10)
      splitter.setBeforeHeight(pageHeight * 9 / 10);

    // Notify event handlers that page refreshing is finished
    this._refreshing = false;
  },

  selectAlbum: function(albumName) {
    this.mediaListView.cascadeFilterSet.set(this._albumFilter, [albumName], 1);
  },

  deselectAlbum: function() {
    this.mediaListView.cascadeFilterSet.set(this._albumFilter, [], 0);
  },

  playSelectedAlbum: function() {
    this.highlightItem(0);
    this._playlist.sendPlayEvent();
  },

  playFromContextMenu: function() {
    this.selectAlbum(this._albumNameFromContextMenu);
    this.playSelectedAlbum();
  },

  /* sbIMediaListViewListener */
  onFilterChanged: function(aChangedView){
    // Do nothing
  },

  onSearchChanged: function(aChangedView){
      this.initDisplay();
  },

  onSortChanged: function(aChangedView){
    // Do nothing
  }
} // End window.mediaPage 


