// MOCK window.centraid — visual-verification harness only, never shipped.
//
// Replaces the runtime's real change-bridge `window.centraid.read/write` (which
// POST to /centraid/_tool/* against a live vault) with an in-page fixture
// store, so the docs/photos blueprint apps render real-looking data with zero
// gateway/vault behind them. Every query/action name below is taken verbatim
// from the app's own app.json manifest and from grepping the app source for
// `window.centraid.read({query:...})` / `act('<action>', ...)` call sites —
// see packages/blueprints/apps/{docs,photos}/app.json and
// packages/blueprints/visual-harness/README.md for the inventory.
//
// This file is inserted as an inline <script> by server.mjs, stamped with the
// SAME CSP nonce static-server.ts minted for the real change-bridge script,
// and placed immediately before the app's own `<script type="module">` — so
// it runs after the real bridge (which it fully replaces) and before any app
// code reads `window.centraid`.
(function () {
  'use strict';

  var qs = new URLSearchParams(location.search);
  var EMPTY_MODE = qs.get('empty') === '1';
  var DENIED_MODE = qs.get('denied') === '1';

  var m = /^\/centraid\/([^/]+)\//.exec(location.pathname);
  var appId = m ? decodeURIComponent(m[1]) : null;

  var BLOB_ROUTE = '/centraid/_vault/blobs';
  var uidCounters = {};
  function uid(prefix) {
    uidCounters[prefix] = (uidCounters[prefix] || 0) + 1;
    return prefix + '-new-' + uidCounters[prefix];
  }
  function isoDaysAgo(days, hour) {
    var d = new Date(Date.now() - days * 86400000);
    if (hour != null) d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  }
  function isoDaysFromNow(days) {
    return new Date(Date.now() + days * 86400000).toISOString();
  }
  function blobUri(id) {
    return BLOB_ROUTE + '/' + encodeURIComponent(id);
  }

  // ---------------------------------------------------------------------
  // Change feed — mirrors window.centraid.onChange(cb) from the real bridge
  // (static-server.ts's injectChangeBridge), but fired directly in-page
  // instead of over an SSE round trip. Neither blueprint app currently
  // registers a listener (both apps just call their own refresh() right
  // after a write), so this is mostly a hook future apps/testers can use —
  // see window.__fixtures below for a manual trigger.
  // ---------------------------------------------------------------------
  var listeners = new Set();
  function fireChange(tables) {
    var detail = { tables: tables || [], ts: Date.now(), source: 'visual-harness-mock' };
    listeners.forEach(function (cb) {
      try {
        cb(detail);
      } catch (_) {
        /* a listener throwing must never break the mock */
      }
    });
    try {
      window.dispatchEvent(new CustomEvent('centraid:datachange', { detail: detail }));
    } catch (_) {}
  }

  // ---------------------------------------------------------------------
  // Docs fixtures — see packages/blueprints/apps/docs/queries/drive.js for
  // the row shape (content_id/title/media_type/byte_size/content_uri/
  // created_at/folder_id/starred/trashed/purge_at) and app.json for the
  // folders-scheme model (folder_id/name/parent_id, root implied by null).
  // ---------------------------------------------------------------------
  function buildDocsStore() {
    if (EMPTY_MODE) return { folders: [], documents: [] };

    var folders = [
      { folder_id: 'folder-taxes', name: 'Taxes', parent_id: null },
      { folder_id: 'folder-leases', name: 'Leases', parent_id: null },
      { folder_id: 'folder-warranties', name: 'Warranties', parent_id: null },
      // Nested: Receipts lives inside Taxes.
      { folder_id: 'folder-receipts', name: 'Receipts', parent_id: 'folder-taxes' },
    ];

    function doc(id, title, mediaType, folderId, days, bytes, extra) {
      var base = {
        content_id: id,
        title: title,
        media_type: mediaType,
        byte_size: bytes,
        content_uri: blobUri(id),
        created_at: isoDaysAgo(days),
        folder_id: folderId,
        starred: false,
        trashed: false,
        purge_at: null,
      };
      return Object.assign(base, extra || {});
    }

    var documents = [
      doc('doc-1', 'Lease Agreement 2024.pdf', 'application/pdf', 'folder-leases', 20, 2_458_000, {
        starred: true,
      }),
      doc('doc-2', 'Passport scan.jpg', 'image/jpeg', null, 45, 1_150_000, { starred: true }),
      doc('doc-3', 'W2-2023.pdf', 'application/pdf', 'folder-taxes', 200, 340_000),
      doc('doc-4', '1099-INT.pdf', 'application/pdf', 'folder-receipts', 190, 120_000),
      doc('doc-5', 'Budget 2025.xlsx', 'application/vnd.ms-excel', null, 5, 88_000, {
        starred: true,
      }),
      doc('doc-6', 'Q1 Expenses.csv', 'text/csv', 'folder-taxes', 10, 12_000),
      doc('doc-7', 'Homeowners policy.pdf', 'application/pdf', 'folder-warranties', 300, 900_000),
      doc(
        'doc-8',
        'Refrigerator warranty.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'folder-warranties',
        280,
        45_000,
      ),
      doc('doc-9', 'Trip itinerary.docx', 'application/msword', null, 60, 30_000),
      doc(
        'doc-10',
        'Pitch deck.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        null,
        15,
        5_600_000,
      ),
      doc('doc-11', 'Vacation photo.png', 'image/png', null, 40, 3_200_000),
      doc('doc-12', 'Car title scan.pdf', 'application/pdf', 'folder-receipts', 100, 500_000, {
        trashed: true,
        purge_at: isoDaysFromNow(12),
      }),
      doc('doc-13', 'Old resume.doc', 'application/msword', null, 500, 60_000, {
        trashed: true,
        purge_at: isoDaysFromNow(3),
      }),
      doc('doc-14', 'backup.zip', 'application/zip', null, 2, 12_400_000),
      doc('doc-15', 'notes.bin', 'application/octet-stream', 'folder-taxes', 1, 4_000),
    ];

    return { folders: folders, documents: documents };
  }

  var docsStore = appId === 'docs' ? buildDocsStore() : null;

  function docsRead(query, input) {
    if (query === 'drive') {
      return {
        folders: docsStore.folders,
        documents: docsStore.documents,
        root_folder_id: 'folder-root',
        truncated: false,
        window: Math.min(Math.max(Number(input.limit) || 200, 20), 2000),
      };
    }
    if (query === 'search') {
      var term = String(input.term || '')
        .trim()
        .toLowerCase();
      if (!term) return { documents: [] };
      var docs = docsStore.documents
        .filter(function (d) {
          return !d.trashed && d.title.toLowerCase().indexOf(term) !== -1;
        })
        .map(function (d) {
          return Object.assign({}, d, { snippet: '…' + d.title + '…' });
        });
      return { documents: docs };
    }
    console.warn('[mock-centraid] docs: unmapped query', query);
    return {};
  }

  function docsWrite(action, input) {
    var docs = docsStore.documents;
    var folders = docsStore.folders;
    function findDoc(id) {
      return docs.find(function (d) {
        return d.content_id === id;
      });
    }
    function findFolder(id) {
      return folders.find(function (f) {
        return f.folder_id === id;
      });
    }
    function ok(output) {
      return { status: 'executed', output: output || {} };
    }
    function refuse(predicate) {
      return { status: 'failed', predicate: predicate, reason: predicate };
    }

    switch (action) {
      case 'upload': {
        var id = uid('doc');
        var title = String(input.title || 'Untitled');
        var ext = (title.split('.').pop() || '').toLowerCase();
        var mediaByExt = {
          pdf: 'application/pdf',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          gif: 'image/gif',
          xlsx: 'application/vnd.ms-excel',
          csv: 'text/csv',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          doc: 'application/msword',
          pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        };
        var mediaType = mediaByExt[ext] || 'application/octet-stream';
        var newDoc = {
          content_id: id,
          title: title,
          media_type: mediaType,
          byte_size: input.data_uri ? Math.round((input.data_uri.length * 3) / 4) : 256_000,
          content_uri: blobUri(id),
          created_at: new Date().toISOString(),
          folder_id: input.folder_id != null ? String(input.folder_id) : null,
          starred: false,
          trashed: false,
          purge_at: null,
        };
        docs.unshift(newDoc);
        return ok({ content_id: id, deduped: false });
      }
      case 'rename': {
        var d1 = findDoc(input.content_id);
        if (!d1) return refuse('not_found');
        if (d1.trashed) return refuse('document_trashed');
        d1.title = String(input.title);
        return ok({ content_id: d1.content_id });
      }
      case 'move': {
        var d2 = findDoc(input.content_id);
        if (!d2) return refuse('not_found');
        d2.folder_id = input.folder_id != null ? String(input.folder_id) : null;
        return ok({ content_id: d2.content_id });
      }
      case 'trash': {
        var d3 = findDoc(input.content_id);
        if (!d3) return refuse('not_found');
        d3.trashed = true;
        d3.purge_at = isoDaysFromNow(30);
        return ok({ content_id: d3.content_id });
      }
      case 'restore': {
        var d4 = findDoc(input.content_id);
        if (!d4) return refuse('not_found');
        d4.trashed = false;
        d4.purge_at = null;
        return ok({ content_id: d4.content_id });
      }
      case 'star': {
        var d5 = findDoc(input.content_id);
        if (!d5) return refuse('not_found');
        if (d5.trashed) return refuse('document_trashed');
        d5.starred = true;
        return ok({ content_id: d5.content_id });
      }
      case 'unstar': {
        var d6 = findDoc(input.content_id);
        if (!d6) return refuse('not_found');
        if (d6.trashed) return refuse('document_trashed');
        d6.starred = false;
        return ok({ content_id: d6.content_id });
      }
      case 'create-folder': {
        var parentId = input.parent_folder_id != null ? String(input.parent_folder_id) : null;
        var name = String(input.name);
        var dup = folders.some(function (f) {
          return f.parent_id === parentId && f.name === name;
        });
        if (dup) return refuse('name_unused_among_siblings');
        var newFolder = { folder_id: uid('folder'), name: name, parent_id: parentId };
        folders.push(newFolder);
        return ok({ folder_id: newFolder.folder_id });
      }
      case 'rename-folder': {
        var f1 = findFolder(input.folder_id);
        if (!f1) return refuse('not_found');
        var newName = String(input.name);
        var dup2 = folders.some(function (f) {
          return f.parent_id === f1.parent_id && f.name === newName && f !== f1;
        });
        if (dup2) return refuse('name_unused_among_siblings');
        f1.name = newName;
        return ok({ folder_id: f1.folder_id });
      }
      case 'delete-folder': {
        var f2 = findFolder(input.folder_id);
        if (!f2) return refuse('not_found');
        var hasDocs = docs.some(function (d) {
          return d.folder_id === f2.folder_id;
        });
        var hasSubfolders = folders.some(function (f) {
          return f.parent_id === f2.folder_id;
        });
        if (hasDocs || hasSubfolders) return refuse('folder_is_empty');
        docsStore.folders = folders.filter(function (f) {
          return f.folder_id !== f2.folder_id;
        });
        return ok({});
      }
      default:
        return null; // unmapped — caller logs + returns {}
    }
  }

  // ---------------------------------------------------------------------
  // Photos fixtures — see packages/blueprints/apps/photos/queries/library.js
  // for the asset row shape (asset_id/kind/content_uri/thumb_uri/favorite/
  // taken_at/album_ids/album_titles/title/media_type/width/height) and
  // queries/faces.js for the face-region shape.
  // ---------------------------------------------------------------------
  function buildPhotosStore() {
    if (EMPTY_MODE) return { assets: [], trash: [], albums: [], faceRegions: [], people: [] };

    var people = [
      { party_id: 'party-mia', name: 'Mia' },
      { party_id: 'party-sam', name: 'Sam' },
      { party_id: 'party-ravi', name: 'Ravi' },
    ];

    var albums = [
      { album_id: 'album-trip', title: 'Summer Trip', cover_content_id: null },
      { album_id: 'album-family', title: 'Family', cover_content_id: null },
    ];
    var tripMembers = ['asset-2', 'asset-5', 'asset-8', 'asset-11', 'asset-14', 'asset-17'];
    var familyMembers = ['asset-3', 'asset-6', 'asset-9', 'asset-12'];

    var assets = [];
    for (var i = 1; i <= 22; i += 1) {
      var monthsBack = i % 3; // 3 distinct months
      var day = ((i * 3) % 27) + 1;
      var d = new Date();
      d.setMonth(d.getMonth() - monthsBack);
      d.setDate(day);
      d.setHours(9 + (i % 10), (i * 7) % 60, 0, 0);
      var isVideo = i % 9 === 0;
      var id = 'asset-' + i;
      var albumIds = [];
      if (tripMembers.indexOf(id) !== -1) albumIds.push('album-trip');
      if (familyMembers.indexOf(id) !== -1) albumIds.push('album-family');
      assets.push({
        asset_id: id,
        content_id: 'content-' + id,
        kind: isVideo ? 'video' : 'photo',
        media_type: isVideo ? 'video/mp4' : 'image/jpeg',
        title: (isVideo ? 'MOV_' : 'IMG_') + (1000 + i) + (isVideo ? '.mp4' : '.jpg'),
        content_uri: blobUri('content-' + id),
        thumb_uri: blobUri('content-' + id) + '?variant=thumb',
        byte_size: isVideo ? 24_000_000 : 2_400_000 + i * 10_000,
        width: isVideo ? 1920 : 1600,
        height: isVideo ? 1080 : 1200,
        duration_s: isVideo ? 42 : null,
        captured_at: d.toISOString(),
        taken_at: d.toISOString(),
        favorite: i % 5 === 0 ? 1 : 0,
        album_ids: albumIds,
        album_titles: albumIds.map(function (aid) {
          return albums.find(function (a) {
            return a.album_id === aid;
          }).title;
        }),
        deleted_at: null,
        purge_at: null,
      });
    }

    // Two trashed assets (ids 23/24), split out of the live window like the
    // real `library` query's separate `trash` array.
    var trash = [23, 24].map(function (n) {
      var id = 'asset-' + n;
      var purgeInDays = n === 23 ? 20 : 25;
      var d = new Date();
      d.setDate(d.getDate() - (30 - purgeInDays));
      return {
        asset_id: id,
        content_id: 'content-' + id,
        kind: 'photo',
        media_type: 'image/jpeg',
        title: 'IMG_' + (1000 + n) + '.jpg',
        content_uri: blobUri('content-' + id),
        thumb_uri: blobUri('content-' + id) + '?variant=thumb',
        byte_size: 1_800_000,
        width: 1600,
        height: 1200,
        duration_s: null,
        captured_at: d.toISOString(),
        taken_at: d.toISOString(),
        favorite: 0,
        album_ids: [],
        album_titles: [],
        deleted_at: d.toISOString(),
        purge_at: isoDaysFromNow(purgeInDays),
        purge_in_days: purgeInDays,
      };
    });

    // Face proposals on 3 assets (issue #299 shape): a mix of confirmed and
    // still-pending proposals, some with a guessed name, some anonymous.
    var faceRegions = [
      {
        region_id: 'region-1',
        asset_id: 'asset-2',
        bbox: { x: 0.2, y: 0.15, w: 0.3, h: 0.3 },
        party_id: 'party-mia',
        person_name: 'Mia',
        confidence: 0.92,
        confirmed: true,
      },
      {
        region_id: 'region-2',
        asset_id: 'asset-2',
        bbox: { x: 0.55, y: 0.2, w: 0.25, h: 0.28 },
        party_id: null,
        person_name: null,
        confidence: 0.61,
        confirmed: false,
      },
      {
        region_id: 'region-3',
        asset_id: 'asset-5',
        bbox: { x: 0.3, y: 0.18, w: 0.28, h: 0.3 },
        party_id: 'party-sam',
        person_name: 'Sam',
        confidence: 0.88,
        confirmed: true,
      },
      {
        region_id: 'region-4',
        asset_id: 'asset-8',
        bbox: { x: 0.4, y: 0.22, w: 0.26, h: 0.27 },
        party_id: null,
        person_name: null,
        confidence: 0.55,
        confirmed: false,
      },
    ];

    return { assets: assets, trash: trash, albums: albums, faceRegions: faceRegions, people: people };
  }

  var photosStore = appId === 'photos' ? buildPhotosStore() : null;

  function photosRead(query, input) {
    if (query === 'library') {
      var limit = Math.min(Math.max(Number(input.limit) || 500, 20), 2000);
      var live = photosStore.assets.slice().sort(function (a, b) {
        return String(b.taken_at).localeCompare(String(a.taken_at));
      });
      var trash = photosStore.trash.slice().sort(function (a, b) {
        return String(b.deleted_at).localeCompare(String(a.deleted_at));
      });
      return {
        assets: live.slice(0, limit),
        albums: photosStore.albums,
        trash: trash,
        truncated: live.length > limit,
        window: limit,
      };
    }
    if (query === 'faces') {
      var assetId = String(input.asset_id || '');
      var regions = photosStore.faceRegions.filter(function (r) {
        return r.asset_id === assetId;
      });
      return {
        regions: regions.map(function (r) {
          return {
            region_id: r.region_id,
            bbox: r.bbox,
            party_id: r.party_id,
            person_name: r.person_name,
            confidence: r.confidence,
            confirmed: r.confirmed,
          };
        }),
        people: photosStore.people,
      };
    }
    console.warn('[mock-centraid] photos: unmapped query', query);
    return {};
  }

  function photosWrite(action, input) {
    var assets = photosStore.assets;
    var trash = photosStore.trash;
    var albums = photosStore.albums;
    function findAsset(id) {
      return (
        assets.find(function (a) {
          return a.asset_id === id;
        }) ||
        trash.find(function (a) {
          return a.asset_id === id;
        })
      );
    }
    function findAlbum(id) {
      return albums.find(function (a) {
        return a.album_id === id;
      });
    }
    function ok(output) {
      return { status: 'executed', output: output || {} };
    }
    function refuse(reason) {
      return { status: 'failed', reason: reason };
    }

    switch (action) {
      case 'upload': {
        var id = uid('asset');
        var contentId = 'content-' + id;
        var kind = input.kind || 'photo';
        var mediaByKind = {
          photo: 'image/jpeg',
          video: 'video/mp4',
          audio: 'audio/mpeg',
          scan: 'image/jpeg',
        };
        var newAsset = {
          asset_id: id,
          content_id: contentId,
          kind: kind,
          media_type: mediaByKind[kind] || 'image/jpeg',
          title: input.title || 'Untitled',
          content_uri: blobUri(contentId),
          thumb_uri: blobUri(contentId) + '?variant=thumb',
          byte_size: input.data_uri ? Math.round((input.data_uri.length * 3) / 4) : 2_000_000,
          width: input.width || 1600,
          height: input.height || 1200,
          duration_s: input.duration_s || null,
          captured_at: input.captured_at || new Date().toISOString(),
          taken_at: input.captured_at || new Date().toISOString(),
          favorite: 0,
          album_ids: [],
          album_titles: [],
          deleted_at: null,
          purge_at: null,
        };
        assets.unshift(newAsset);
        return ok({ asset_id: id, deduped: false });
      }
      case 'update-asset': {
        var a1 = findAsset(input.asset_id);
        if (!a1) return refuse('not_found');
        if (input.captured_at != null) {
          a1.captured_at = input.captured_at;
          a1.taken_at = input.captured_at;
        }
        if (input.title != null) a1.title = input.title;
        if (input.favorite != null) a1.favorite = Number(input.favorite);
        return ok({ asset_id: a1.asset_id });
      }
      case 'delete-asset': {
        var idx = assets.findIndex(function (a) {
          return a.asset_id === input.asset_id;
        });
        if (idx === -1) return refuse('not_found');
        var moved = assets.splice(idx, 1)[0];
        moved.deleted_at = new Date().toISOString();
        moved.purge_at = isoDaysFromNow(30);
        moved.purge_in_days = 30;
        moved.album_ids = [];
        moved.album_titles = [];
        trash.unshift(moved);
        return ok({ asset_id: moved.asset_id });
      }
      case 'restore': {
        var tIdx = trash.findIndex(function (a) {
          return a.asset_id === input.asset_id;
        });
        if (tIdx === -1) return refuse('not_in_trash');
        var back = trash.splice(tIdx, 1)[0];
        back.deleted_at = null;
        back.purge_at = null;
        delete back.purge_in_days;
        assets.unshift(back);
        return ok({ asset_id: back.asset_id });
      }
      case 'create-album': {
        var album = { album_id: uid('album'), title: String(input.title), cover_content_id: null };
        albums.push(album);
        return ok({ album_id: album.album_id });
      }
      case 'rename-album': {
        var al1 = findAlbum(input.album_id);
        if (!al1) return refuse('not_found');
        al1.title = String(input.title);
        assets.forEach(function (a) {
          if (a.album_ids.indexOf(al1.album_id) !== -1) {
            a.album_titles = a.album_ids.map(function (aid) {
              return findAlbum(aid).title;
            });
          }
        });
        return ok({ album_id: al1.album_id });
      }
      case 'delete-album': {
        var al2 = findAlbum(input.album_id);
        if (!al2) return refuse('not_found');
        photosStore.albums = albums.filter(function (a) {
          return a.album_id !== al2.album_id;
        });
        assets.forEach(function (a) {
          var at = a.album_ids.indexOf(al2.album_id);
          if (at !== -1) {
            a.album_ids.splice(at, 1);
            a.album_titles = a.album_ids.map(function (aid) {
              return findAlbum(aid).title;
            });
          }
        });
        return ok({});
      }
      case 'add-to-album': {
        var a2 = findAsset(input.asset_id);
        var al3 = findAlbum(input.album_id);
        if (!a2 || !al3) return refuse('not_found');
        if (a2.album_ids.indexOf(al3.album_id) !== -1) return refuse('already_in_album');
        a2.album_ids.push(al3.album_id);
        a2.album_titles.push(al3.title);
        return ok({});
      }
      case 'remove-from-album': {
        var a3 = findAsset(input.asset_id);
        if (!a3) return refuse('not_found');
        var pos = a3.album_ids.indexOf(input.album_id);
        if (pos !== -1) {
          a3.album_ids.splice(pos, 1);
          a3.album_titles = a3.album_ids.map(function (aid) {
            return findAlbum(aid).title;
          });
        }
        return ok({});
      }
      case 'confirm-face': {
        var r1 = photosStore.faceRegions.find(function (r) {
          return r.region_id === input.region_id;
        });
        if (!r1) return refuse('not_found');
        var person = photosStore.people.find(function (p) {
          return p.party_id === input.party_id;
        });
        r1.party_id = input.party_id;
        r1.person_name = person ? person.name : null;
        r1.confirmed = true;
        return ok({ region_id: r1.region_id });
      }
      case 'reject-face': {
        var before = photosStore.faceRegions.length;
        photosStore.faceRegions = photosStore.faceRegions.filter(function (r) {
          return r.region_id !== input.region_id;
        });
        if (photosStore.faceRegions.length === before) return refuse('not_found');
        return ok({});
      }
      default:
        return null; // unmapped — caller logs + returns {}
    }
  }

  // ---------------------------------------------------------------------
  // window.centraid — fully replaces the real change-bridge's version
  // (static-server.ts's injectChangeBridge, which ran just before this
  // script and already opened an EventSource against our harness's
  // no-op `_changes` stub — harmless, left connected).
  // ---------------------------------------------------------------------
  window.centraid = {
    appId: appId,
    async read(opts) {
      opts = opts || {};
      if (DENIED_MODE) return { vaultDenied: { message: 'Grant revoked.' } };
      if (appId === 'docs') return docsRead(opts.query, opts.input || {});
      if (appId === 'photos') return photosRead(opts.query, opts.input || {});
      console.warn('[mock-centraid] unknown appId for read()', appId);
      return {};
    },
    async write(opts) {
      opts = opts || {};
      if (DENIED_MODE) return { status: 'denied', reason: 'Grant revoked.' };
      var result = null;
      if (appId === 'docs') result = docsWrite(opts.action, opts.input || {});
      else if (appId === 'photos') result = photosWrite(opts.action, opts.input || {});
      else console.warn('[mock-centraid] unknown appId for write()', appId);
      if (result == null) {
        console.warn('[mock-centraid] unmapped action, returning {}', opts.action, opts.input);
        return {};
      }
      fireChange([appId]);
      return result;
    },
    async describe() {
      return { app: appId };
    },
    onChange(cb) {
      if (typeof cb !== 'function') return function () {};
      listeners.add(cb);
      return function () {
        listeners.delete(cb);
      };
    },
  };

  // Escape hatch for the browser-driving tester: inspect or reset fixture
  // state from devtools / preview_eval without reloading the page.
  window.__fixtures = {
    appId: appId,
    emptyMode: EMPTY_MODE,
    deniedMode: DENIED_MODE,
    get state() {
      return appId === 'docs' ? docsStore : appId === 'photos' ? photosStore : null;
    },
    reset() {
      if (appId === 'docs') docsStore = buildDocsStore();
      else if (appId === 'photos') photosStore = buildPhotosStore();
      fireChange([appId]);
    },
    fireChange: fireChange,
  };

  console.info(
    '[mock-centraid] armed for app=' + appId + (EMPTY_MODE ? ' (empty)' : '') + (DENIED_MODE ? ' (denied)' : ''),
  );
})();
