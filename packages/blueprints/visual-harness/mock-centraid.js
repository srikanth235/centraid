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
  // Local YYYY-MM-DD day key (not a full ISO timestamp) — the shape tasks'
  // queries/board.js and app.jsx's format.js (localDayKey) both use for
  // due_at/completed_at.
  function dayKey(offsetDays) {
    var d = new Date();
    d.setDate(d.getDate() + offsetDays);
    var p = function (n) {
      return String(n).padStart(2, '0');
    };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  // The tasks fixture's parked-write trigger (see buildTasksStore below): any
  // add/edit/set-status/attach/detach touching a task whose title carries
  // "(park)" returns a parked outcome instead of executing, so the harness
  // can show the accent-rail/pending-chip treatment without a real vault.
  function isParkTrigger(text) {
    return typeof text === 'string' && /\(park\)/i.test(text);
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
  // Tasks fixtures — see packages/blueprints/apps/tasks/queries/board.js for
  // the row shape (task_id/title/description/due_at/priority/effort_min/
  // status/completed_at/rrule/children/done_children/attachments) and
  // queries/search.js for the FTS-hit shape (adds `snippet`). Priority is
  // RFC 5545 (0 none, 1-3 high, 4-6 medium, 7-9 low). Covers every bucket the
  // board groups into (overdue/today/week/later/anytime), an in-process task,
  // a recurring task, a task with subtasks (1/3 done), one with an
  // attachment, the logbook (completed + cancelled), and the "(park)" title
  // trigger for the parked-write path — see isParkTrigger above.
  // ---------------------------------------------------------------------
  function buildTasksStore() {
    if (EMPTY_MODE) return { tasks: [] };

    function task(id, title, opts) {
      opts = opts || {};
      return {
        task_id: id,
        title: title,
        description: opts.description || '',
        due_at: opts.due !== undefined ? (opts.due == null ? null : dayKey(opts.due)) : null,
        priority: opts.priority || 0,
        effort_min: opts.effort_min || null,
        status: opts.status || 'needs-action',
        completed_at:
          opts.completedAt !== undefined ? (opts.completedAt == null ? null : dayKey(opts.completedAt)) : null,
        parent_task_id: opts.parent || null,
        rrule: opts.rrule || null,
        attachments: opts.attachments || [],
      };
    }

    var tasks = [
      task('task-overdue-1', 'Reply to the studio contract email', { due: -2, priority: 1 }),
      task('task-overdue-2', 'Book the dentist', { due: -1 }),
      task('task-today-1', 'Finish Tasks reinvention writeup', {
        due: 0,
        priority: 2,
        effort_min: 45,
        status: 'in-process',
        description: 'Ship the build prompt with the live URL.',
        attachments: [
          {
            attachment_id: 'att-1',
            content_id: 'content-task-today-1-1',
            role: 'other',
            is_primary: 1,
            media_type: 'application/pdf',
            title: 'writeup-draft.pdf',
            content_uri: blobUri('content-task-today-1-1'),
            byte_size: 182_000,
          },
        ],
      }),
      task('task-today-2', 'Water the plants', { due: 0, effort_min: 5, rrule: 'FREQ=DAILY' }),
      task('task-week-1', 'Sign the lease renewal (park)', { due: 1, priority: 1 }),
      task('task-week-2', 'Review Q3 budget', {
        due: 3,
        priority: 4,
        effort_min: 60,
        description: 'Cross-check against the vault ledger.',
      }),
      task('task-week-3', 'Draft the Tasks v2 prompt', { due: 5, priority: 5 }),
      task('task-later-1', 'Renew the domain', { due: 10 }),
      task('task-later-2', 'Plan the coast weekend', {
        due: 9,
        effort_min: 30,
        description: 'Cabin + one big hike.',
      }),
      task('task-later-2-sub-1', 'Reserve the cabin', { status: 'completed', parent: 'task-later-2' }),
      task('task-later-2-sub-2', 'Map the trail', { parent: 'task-later-2' }),
      task('task-later-2-sub-3', 'Pack list', { parent: 'task-later-2' }),
      task('task-anytime-1', 'Read “Thinking in Systems”', {
        priority: 8,
        description: 'Chapter on stocks and flows.',
      }),
      task('task-anytime-2', 'Clean up the downloads folder', { effort_min: 20 }),
      task('task-anytime-3', 'Sketch the Vitals dashboard', { priority: 5 }),
      task('task-done-1', 'Ship Tasks reinvention', {
        priority: 1,
        status: 'completed',
        completedAt: 0,
      }),
      task('task-done-2', 'Send the weekly review', { status: 'completed', completedAt: -2 }),
      task('task-cancel-1', 'Cancel the old newsletter', { status: 'cancelled', completedAt: -3 }),
    ];
    return { tasks: tasks };
  }

  var tasksStore = appId === 'tasks' ? buildTasksStore() : null;

  function tasksRead(query, input) {
    if (query === 'board') {
      var limit = Math.min(Math.max(Number(input.limit) || 500, 20), 2000);
      var OPEN = { 'needs-action': true, 'in-process': true };
      function withAttachments(t) {
        return Object.assign({}, t, { attachments: t.attachments || [], references: [] });
      }
      function withChildren(t) {
        var children = tasksStore.tasks
          .filter(function (c) {
            return c.parent_task_id === t.task_id;
          })
          .map(withAttachments);
        return Object.assign({}, withAttachments(t), {
          children: children,
          done_children: children.filter(function (c) {
            return !OPEN[c.status];
          }).length,
        });
      }
      var openTop = tasksStore.tasks.filter(function (t) {
        return !t.parent_task_id && OPEN[t.status];
      });
      var closedTop = tasksStore.tasks
        .filter(function (t) {
          return !t.parent_task_id && !OPEN[t.status];
        })
        .slice()
        .sort(function (a, b) {
          return String(b.completed_at || '').localeCompare(String(a.completed_at || ''));
        });
      return {
        open: openTop.slice(0, limit).map(withChildren),
        logbook: closedTop.slice(0, 50).map(withChildren),
        counts: { open: openTop.length, closed: closedTop.length },
        truncated: openTop.length > limit,
        window: limit,
      };
    }
    if (query === 'search') {
      var term = String(input.term || '')
        .trim()
        .toLowerCase();
      if (!term) return { tasks: [] };
      var hits = tasksStore.tasks.filter(function (t) {
        return (t.title + ' ' + (t.description || '')).toLowerCase().indexOf(term) !== -1;
      });
      return {
        tasks: hits.map(function (t) {
          var snippet = t.description && t.description.toLowerCase().indexOf(term) !== -1 ? '…⟦' + t.description + '⟧…' : '';
          return Object.assign({}, t, { attachments: t.attachments || [], snippet: snippet });
        }),
      };
    }
    console.warn('[mock-centraid] tasks: unmapped query', query);
    return {};
  }

  function tasksWrite(action, input) {
    function findTask(id) {
      return tasksStore.tasks.find(function (t) {
        return t.task_id === id;
      });
    }
    function ok(output) {
      return { status: 'executed', invocationId: uid('inv'), receiptId: uid('receipt'), output: output || {} };
    }
    function refuse(reason) {
      return { status: 'failed', reason: reason, predicate: reason };
    }
    function parked() {
      return { status: 'parked', invocationId: uid('inv') };
    }

    switch (action) {
      case 'add': {
        var title = String(input.title || '').trim();
        if (isParkTrigger(title)) return parked();
        var id = uid('task');
        var t0 = {
          task_id: id,
          title: title,
          description: input.description || '',
          due_at: input.due_at || null,
          priority: input.priority || 0,
          effort_min: input.effort_min || null,
          status: 'needs-action',
          completed_at: null,
          parent_task_id: input.parent_task_id || null,
          rrule: null,
          attachments: [],
        };
        tasksStore.tasks.unshift(t0);
        return ok({ task_id: id });
      }
      case 'set-status': {
        var t1 = findTask(input.task_id);
        if (!t1) return refuse('not_found');
        if (isParkTrigger(t1.title)) return parked();
        t1.status = input.status;
        t1.completed_at = input.status === 'completed' || input.status === 'cancelled' ? dayKey(0) : null;
        return ok({ task_id: t1.task_id });
      }
      case 'edit': {
        var t2 = findTask(input.task_id);
        if (!t2) return refuse('not_found');
        if (isParkTrigger(t2.title)) return parked();
        if (input.title) t2.title = String(input.title);
        if (input.description) t2.description = String(input.description);
        if (input.clear_description) t2.description = '';
        if (input.due_at) t2.due_at = String(input.due_at);
        if (input.clear_due) t2.due_at = null;
        if (input.priority !== undefined) t2.priority = Number(input.priority);
        if (input.effort_min) t2.effort_min = Number(input.effort_min);
        return ok({ task_id: t2.task_id });
      }
      case 'attach': {
        var t3 = findTask(input.subject_id);
        if (!t3) return refuse('not_found');
        if (isParkTrigger(t3.title)) return parked();
        var contentId = uid('content');
        var attachment = {
          attachment_id: uid('att'),
          content_id: contentId,
          role: input.role || 'other',
          is_primary: 0,
          media_type: 'application/octet-stream',
          title: input.title || 'file',
          content_uri: blobUri(contentId),
          byte_size: 40_000,
        };
        t3.attachments = (t3.attachments || []).concat([attachment]);
        return ok({ attachment_id: attachment.attachment_id });
      }
      case 'detach': {
        var owner = null;
        tasksStore.tasks.forEach(function (t) {
          var idx = (t.attachments || []).findIndex(function (a) {
            return a.attachment_id === input.attachment_id;
          });
          if (idx !== -1) {
            owner = t;
            t.attachments.splice(idx, 1);
          }
        });
        if (!owner) return refuse('not_found');
        return ok({});
      }
      default:
        return null; // unmapped — caller logs + returns {}
    }
  }

  // ---------------------------------------------------------------------
  // Notes fixtures — see packages/blueprints/apps/notes/queries/library.js
  // for the row shape (note_id/title/format/pinned/created_at/updated_at/
  // body/notebook_ids/notebook_names/attachments/references) and
  // queries/search.js for the FTS-hit shape (adds `snippet`). Covers several
  // notebooks, pinned notes, checklist notes with partial progress,
  // markdown-ish bodies (headings/bullets/checklists), a long
  // masonry-worthy spread, one note with an attachment, and the "(park)"
  // marker convention for both a note and a notebook — see isParkTrigger
  // above.
  // ---------------------------------------------------------------------
  function buildNotesStore() {
    if (EMPTY_MODE) return { notes: [], notebooks: [] };

    var notebooks = [
      { notebook_id: 'nb-personal', name: 'Personal', sort_order: 0 },
      { notebook_id: 'nb-work', name: 'Work', sort_order: 1 },
      { notebook_id: 'nb-recipes', name: 'Recipes', sort_order: 2 },
      { notebook_id: 'nb-travel', name: 'Travel', sort_order: 3 },
      { notebook_id: 'nb-archive', name: 'Archive (park)', sort_order: 4 },
    ];

    function note(id, title, body, opts) {
      opts = opts || {};
      return {
        note_id: id,
        title: title,
        format: 'markdown',
        pinned: opts.pinned ? 1 : 0,
        created_at: isoDaysAgo(opts.age != null ? opts.age : 1),
        updated_at: isoDaysAgo(opts.age != null ? opts.age : 1, opts.hour),
        body: body,
        notebook_ids: opts.notebook ? [opts.notebook] : [],
        attachments: opts.attachments || [],
        references: [],
      };
    }

    var notes = [
      note(
        'note-weekly',
        'Weekly review ritual',
        '## Every Friday, 25 min\n- [x] Clear the inbox to zero\n- [x] Skim last week’s notes\n- [ ] Pick 3 outcomes for next week\n- [ ] Park anything that can wait\n\nThe point is momentum, not perfection.',
        { pinned: true, notebook: 'nb-work', age: 0, hour: 8 },
      ),
      note(
        'note-reading',
        'Reading list',
        '- [ ] The Beginning of Infinity\n- [x] Thinking in Systems\n- [ ] A Pattern Language\n- [ ] The Timeless Way of Building',
        { pinned: true, notebook: 'nb-personal', age: 3 },
      ),
      note(
        'note-sourdough',
        'Sourdough — the loaf that works (park)',
        '## Levain\n50g starter, 50g water, 50g flour. 4–6h.\n\n## Dough\n500g flour, 350g water, 100g levain, 10g salt.\n\n- [ ] Autolyse 1h\n- [ ] 4 stretch-and-folds, 30 min apart\n- [ ] Bulk until +50%\n- [ ] Shape, cold proof overnight\n- [ ] Bake 500°F, lid on 20 min, off 20 min',
        { notebook: 'nb-recipes', age: 5 },
      ),
      note(
        'note-parking-lot',
        'Ideas parking lot',
        'A tiny app that only tells you the *next* thing.\n\nA calendar that hides everything except today.\n\nNotes that decay unless you touch them.',
        { age: 1 },
      ),
      note(
        'note-lisbon',
        'Trip to Lisbon',
        '## Must do\n- [x] Book the Alfama place\n- [ ] Day trip to Sintra\n- [ ] Pastel de nata crawl\n- [ ] Sunset at Miradouro\n\nGetting around: buy the Viva Viagem card at the airport.',
        { notebook: 'nb-travel', age: 12 },
      ),
      note(
        'note-standup',
        'Standup notes',
        'Yesterday: shipped the vault receipt viewer.\nToday: notes reinvention, card wall + editor.\nBlockers: none.',
        { notebook: 'nb-work', age: 0, hour: 9 },
      ),
      note(
        'note-gifts',
        'Gift ideas',
        '- [ ] Dad — the good headphones\n- [ ] Maya — pottery class\n- [x] Sam — that cookbook',
        { notebook: 'nb-personal', age: 20 },
      ),
      note(
        'note-writing',
        'On writing',
        'Write the **boring** first draft fast.\n\nCut every sentence that is trying too hard.\n\nRead it aloud. If you stumble, so will they.',
        { age: 30 },
      ),
      note(
        'note-pasta',
        'Weeknight pasta',
        'Garlic in cold oil, low heat. Anchovy melts in. Chili. Pasta water does the rest.\n\n- [ ] Buy good parmesan\n- [ ] More lemon than you think',
        { notebook: 'nb-recipes', age: 25 },
      ),
      note(
        'note-wifi',
        'Home wifi + accounts',
        'Router lives behind the books.\n\n- [ ] Rename the guest network\n- [ ] Rotate the long password',
        { notebook: 'nb-personal', age: 45 },
      ),
      note(
        'note-goals',
        'Q3 goals',
        '# Three bets\n1. Reinvent three vault apps end to end.\n2. Ship the receipt timeline everywhere.\n3. One doc a week, no exceptions.',
        { notebook: 'nb-work', age: 60 },
      ),
      note(
        'note-plants',
        'Plant care',
        '- [ ] Monstera — water Sundays\n- [ ] Snake plant — every 3 weeks\n- [x] Repot the fiddle-leaf',
        { age: 80 },
      ),
      note(
        'note-onboarding',
        'Onboarding packet',
        'The signed PDF is attached below.\n\n- [x] Send the packet\n- [ ] Collect the signed copy',
        {
          notebook: 'nb-work',
          age: 2,
          attachments: [
            {
              attachment_id: 'att-onboard-1',
              content_id: 'content-onboard-1',
              role: 'other',
              is_primary: 1,
              media_type: 'application/pdf',
              title: 'onboarding-packet.pdf',
              content_uri: blobUri('content-onboard-1'),
              byte_size: 240_000,
            },
          ],
        },
      ),
    ];
    return { notes: notes, notebooks: notebooks };
  }

  var notesStore = appId === 'notes' ? buildNotesStore() : null;

  function notebookNamesFor(n) {
    return n.notebook_ids.map(function (id) {
      var nb = notesStore.notebooks.find(function (x) {
        return x.notebook_id === id;
      });
      return nb ? nb.name : 'Notebook';
    });
  }

  function notesRead(query, input) {
    if (query === 'library') {
      var limit = Math.min(Math.max(Number(input.limit) || 200, 20), 2000);
      var sorted = notesStore.notes.slice().sort(function (a, b) {
        return b.pinned - a.pinned || String(b.updated_at).localeCompare(String(a.updated_at));
      });
      var windowed = sorted.slice(0, limit);
      // Pinned notes ride beside the window even when older than its edge —
      // mirrors library.js's own pinned-notes side read.
      var pinnedOutside = sorted.slice(limit).filter(function (n) {
        return n.pinned === 1;
      });
      var rows = windowed.concat(pinnedOutside).map(function (n) {
        return Object.assign({}, n, { notebook_names: notebookNamesFor(n) });
      });
      return {
        notes: rows,
        notebooks: notesStore.notebooks,
        truncated: sorted.length > limit,
        window: limit,
      };
    }
    if (query === 'search') {
      var term = String(input.term || '')
        .trim()
        .toLowerCase();
      if (!term) return { notes: [] };
      var hits = notesStore.notes.filter(function (n) {
        return (n.title + ' ' + n.body).toLowerCase().indexOf(term) !== -1;
      });
      return {
        notes: hits.map(function (n) {
          var snippet = n.body.toLowerCase().indexOf(term) !== -1 ? '…⟦' + n.body.slice(0, 80) + '⟧…' : '';
          return Object.assign({}, n, { notebook_names: notebookNamesFor(n), snippet: snippet });
        }),
      };
    }
    console.warn('[mock-centraid] notes: unmapped query', query);
    return {};
  }

  function notesWrite(action, input) {
    function findNote(id) {
      return notesStore.notes.find(function (n) {
        return n.note_id === id;
      });
    }
    function findNotebook(id) {
      return notesStore.notebooks.find(function (nb) {
        return nb.notebook_id === id;
      });
    }
    function ok(output) {
      return { status: 'executed', invocationId: uid('inv'), receiptId: uid('receipt'), output: output || {} };
    }
    function refuse(predicate) {
      return { status: 'failed', reason: predicate, predicate: predicate };
    }
    function parked() {
      return { status: 'parked', invocationId: uid('inv') };
    }

    switch (action) {
      case 'create-note': {
        var title = String(input.title || '').trim();
        var body = String(input.body_text || '');
        if (isParkTrigger(title) || isParkTrigger(body)) return parked();
        var id = uid('note');
        var n0 = {
          note_id: id,
          title: title,
          format: input.format || 'markdown',
          pinned: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          body: body,
          notebook_ids: input.notebook_id ? [input.notebook_id] : [],
          attachments: [],
          references: [],
        };
        notesStore.notes.unshift(n0);
        return ok({ note_id: id });
      }
      case 'edit-note': {
        var n1 = findNote(input.note_id);
        if (!n1) return refuse('not_found');
        if (isParkTrigger(n1.title)) return parked();
        if (input.title != null) n1.title = String(input.title);
        if (input.body_text != null) n1.body = String(input.body_text);
        if (input.format != null) n1.format = String(input.format);
        if (input.pinned != null) n1.pinned = Number(input.pinned);
        n1.updated_at = new Date().toISOString();
        return ok({ note_id: n1.note_id });
      }
      case 'move-note': {
        var n2 = findNote(input.note_id);
        if (!n2) return refuse('not_found');
        if (isParkTrigger(n2.title)) return parked();
        n2.notebook_ids = input.notebook_id ? [input.notebook_id] : [];
        n2.updated_at = new Date().toISOString();
        return ok({ note_id: n2.note_id });
      }
      case 'create-notebook': {
        var name = String(input.name || '').trim();
        if (isParkTrigger(name)) return parked();
        var already = notesStore.notebooks.some(function (nb) {
          return nb.name === name;
        });
        if (already) return refuse('name_unused_by_owner');
        var nbId = uid('nb');
        notesStore.notebooks.push({ notebook_id: nbId, name: name, sort_order: notesStore.notebooks.length });
        return ok({ notebook_id: nbId });
      }
      case 'rename-notebook': {
        var nb1 = findNotebook(input.notebook_id);
        if (!nb1) return refuse('not_found');
        var newName = String(input.name || '').trim();
        if (isParkTrigger(nb1.name) || isParkTrigger(newName)) return parked();
        if (newName === nb1.name) return ok({ notebook_id: nb1.notebook_id });
        var dupe = notesStore.notebooks.some(function (nb) {
          return nb.notebook_id !== nb1.notebook_id && nb.name === newName;
        });
        if (dupe) return refuse('name_unused_by_owner');
        nb1.name = newName;
        return ok({ notebook_id: nb1.notebook_id });
      }
      case 'delete-notebook': {
        var nb2 = findNotebook(input.notebook_id);
        if (!nb2) return refuse('not_found');
        if (isParkTrigger(nb2.name)) return parked();
        var unfiled = 0;
        notesStore.notes.forEach(function (n) {
          var idx = n.notebook_ids.indexOf(nb2.notebook_id);
          if (idx !== -1) {
            n.notebook_ids.splice(idx, 1);
            unfiled += 1;
          }
        });
        notesStore.notebooks = notesStore.notebooks.filter(function (nb) {
          return nb.notebook_id !== nb2.notebook_id;
        });
        return ok({ notes_unfiled: unfiled });
      }
      case 'delete-note': {
        var n3 = findNote(input.note_id);
        if (!n3) return refuse('not_found');
        if (isParkTrigger(n3.title)) return parked();
        notesStore.notes = notesStore.notes.filter(function (n) {
          return n.note_id !== n3.note_id;
        });
        return ok({});
      }
      case 'attach': {
        var n4 = findNote(input.subject_id);
        if (!n4) return refuse('not_found');
        if (isParkTrigger(n4.title)) return parked();
        var contentId = uid('content');
        var attachment = {
          attachment_id: uid('att'),
          content_id: contentId,
          role: input.role || 'other',
          is_primary: 0,
          media_type: 'application/octet-stream',
          title: input.title || 'file',
          content_uri: blobUri(contentId),
          byte_size: 40_000,
        };
        n4.attachments = (n4.attachments || []).concat([attachment]);
        return ok({ attachment_id: attachment.attachment_id });
      }
      case 'detach': {
        var owner = null;
        notesStore.notes.forEach(function (n) {
          var idx = (n.attachments || []).findIndex(function (a) {
            return a.attachment_id === input.attachment_id;
          });
          if (idx !== -1) {
            owner = n;
            n.attachments.splice(idx, 1);
          }
        });
        if (!owner) return refuse('not_found');
        return ok({});
      }
      default:
        return null; // unmapped — caller logs + returns {}
    }
  }

  // ---------------------------------------------------------------------
  // Agenda fixtures — see packages/blueprints/apps/agenda/queries/upcoming.js
  // for the real row shape (event_id/summary/description/dtstart/dtend/
  // status/calendar_id/attachments) and search.js for the FTS-hit shape
  // (adds `snippet`). `attendees` is a MOCK-ONLY addition (see EventDrawer.jsx's
  // header comment): upcoming.js/search.js are kept untouched per the
  // integration brief, so the real query never returns guests today — this
  // fixture still carries them so the harness can show the Guests/RSVP UI.
  // Covers: 4 calendars with colors, timed events with a same-slot overlap
  // (week-view columns), an all-day event, a multi-day event spanning
  // "today" (exercises the from-boundary "still running" rule), guests with
  // varied PARTSTAT including a "You" row, a tentative event, an event whose
  // title carries the "(park)" marker (every write against it parks — see
  // isParkTrigger), an attachment, and a day with 5 events for month view's
  // "+N more".
  // ---------------------------------------------------------------------
  function buildAgendaStore() {
    if (EMPTY_MODE) return { calendars: [], events: [] };

    var calendars = [
      { calendar_id: 'cal-personal', name: 'Personal', color: '#4E68DD' },
      { calendar_id: 'cal-work', name: 'Work', color: '#2EA098' },
      { calendar_id: 'cal-family', name: 'Family', color: '#E55772' },
      { calendar_id: 'cal-focus', name: 'Focus', color: '#7C5BD9' },
    ];

    var base = new Date();
    base.setHours(0, 0, 0, 0);
    function at(offsetDays, h, m) {
      var d = new Date(base.getTime());
      d.setDate(d.getDate() + offsetDays);
      d.setHours(h, m, 0, 0);
      return d.toISOString();
    }
    function atMid(offsetDays) {
      var d = new Date(base.getTime());
      d.setDate(d.getDate() + offsetDays);
      return d.toISOString();
    }
    var you = { party_id: 'party-you', name: 'You', partstat: 'accepted', is_you: true };
    function guest(id, name, partstat) {
      return { party_id: id, name: name, partstat: partstat, is_you: false };
    }

    var events = [
      {
        event_id: 'ev-standup',
        summary: 'Team standup',
        description: 'Quick round — yesterday, today, blockers.',
        dtstart: at(0, 9, 30),
        dtend: at(0, 9, 45),
        status: 'confirmed',
        calendar_id: 'cal-work',
        attachments: [],
        attendees: [you, guest('p-sam', 'Sam Cole', 'accepted'), guest('p-dana', 'Dana Ruiz', 'declined')],
      },
      {
        event_id: 'ev-review',
        summary: 'Design review — Agenda',
        description: 'Walk through the reinvented calendar canvas.',
        dtstart: at(0, 11, 0),
        dtend: at(0, 12, 0),
        status: 'confirmed',
        calendar_id: 'cal-work',
        attachments: [],
        attendees: [you, guest('p-priya', 'Priya Nair', 'tentative')],
      },
      {
        event_id: 'ev-lunch',
        summary: 'Lunch with Dana',
        description: '',
        dtstart: at(0, 12, 0),
        dtend: at(0, 13, 0),
        status: 'confirmed',
        calendar_id: 'cal-personal',
        attachments: [],
        attendees: [],
      },
      {
        // Overlaps ev-lunch same day/slot — exercises the week view's
        // side-by-side overlap-column layout.
        event_id: 'ev-vendor-call',
        summary: 'Vendor call',
        description: '',
        dtstart: at(0, 12, 15),
        dtend: at(0, 13, 15),
        status: 'confirmed',
        calendar_id: 'cal-work',
        attachments: [],
        attendees: [],
      },
      {
        event_id: 'ev-1on1',
        summary: '1:1 with Sam',
        description: '',
        dtstart: at(0, 15, 0),
        dtend: at(0, 15, 30),
        status: 'confirmed',
        calendar_id: 'cal-work',
        attachments: [],
        attendees: [you, guest('p-sam', 'Sam Cole', 'accepted')],
      },
      {
        event_id: 'ev-deepwork',
        summary: 'Deep work — inbox to zero',
        description: '',
        dtstart: at(0, 16, 0),
        dtend: at(0, 17, 30),
        status: 'confirmed',
        calendar_id: 'cal-focus',
        attachments: [],
        attendees: [],
      },
      {
        // Every write against this event parks (isParkTrigger on the title)
        // — the reliable way to exercise reschedule/rsvp/attach/cancel's
        // parked treatment from the harness.
        event_id: 'ev-dentist',
        summary: 'Dentist (park)',
        description: 'Cleaning. Bring the insurance card.',
        dtstart: at(1, 8, 0),
        dtend: at(1, 9, 0),
        status: 'confirmed',
        calendar_id: 'cal-personal',
        attachments: [],
        attendees: [],
      },
      {
        event_id: 'ev-sprint',
        summary: 'Sprint planning',
        description: '',
        dtstart: at(1, 10, 0),
        dtend: at(1, 11, 30),
        status: 'confirmed',
        calendar_id: 'cal-work',
        attachments: [],
        attendees: [you, guest('p-sam', 'Sam Cole', 'accepted'), guest('p-priya', 'Priya Nair', 'declined')],
      },
      {
        event_id: 'ev-yoga',
        summary: 'Yoga',
        description: '',
        dtstart: at(1, 18, 0),
        dtend: at(1, 19, 0),
        status: 'confirmed',
        calendar_id: 'cal-personal',
        attachments: [],
        attendees: [],
      },
      {
        event_id: 'ev-family-dinner',
        summary: 'Family dinner',
        description: 'At mum’s. Bring dessert.',
        dtstart: at(2, 19, 0),
        dtend: at(2, 21, 0),
        status: 'confirmed',
        calendar_id: 'cal-family',
        attachments: [],
        attendees: [],
      },
      {
        event_id: 'ev-coffee',
        summary: 'Coffee with Alex',
        description: '',
        dtstart: at(2, 14, 0),
        dtend: at(2, 14, 45),
        status: 'confirmed',
        calendar_id: 'cal-personal',
        attachments: [],
        attendees: [],
      },
      {
        event_id: 'ev-product-sync',
        summary: 'Product sync',
        description: '',
        dtstart: at(3, 13, 30),
        dtend: at(3, 14, 30),
        status: 'tentative',
        calendar_id: 'cal-work',
        attachments: [],
        attendees: [you, guest('p-priya', 'Priya Nair', 'accepted')],
      },
      {
        // Multi-day, spans "today" — the still-running-at-`from` rule
        // (queries/upcoming.js's SPAN_BUFFER_MS) keeps it visible even
        // though it started before the visible window.
        event_id: 'ev-offsite',
        summary: 'Offsite retreat',
        description: 'Coast cabin, team offsite.',
        dtstart: atMid(-3),
        dtend: atMid(2),
        status: 'confirmed',
        calendar_id: 'cal-family',
        attachments: [],
        attendees: [],
      },
      {
        event_id: 'ev-retro',
        summary: 'Retro',
        description: '',
        dtstart: at(-1, 16, 0),
        dtend: at(-1, 17, 0),
        status: 'confirmed',
        calendar_id: 'cal-work',
        attachments: [],
        attendees: [],
      },
      {
        event_id: 'ev-museum',
        summary: 'Museum with the kids',
        description: '',
        dtstart: at(-2, 10, 0),
        dtend: at(-2, 12, 30),
        status: 'confirmed',
        calendar_id: 'cal-family',
        attachments: [],
        attendees: [],
      },
      {
        event_id: 'ev-taxes',
        summary: 'Pay quarterly taxes',
        description: '',
        dtstart: atMid(9),
        dtend: atMid(10),
        status: 'confirmed',
        calendar_id: 'cal-personal',
        attachments: [],
        attendees: [],
      },
      {
        event_id: 'ev-bookclub',
        summary: 'Book club',
        description: '',
        dtstart: at(11, 19, 0),
        dtend: at(11, 20, 30),
        status: 'confirmed',
        calendar_id: 'cal-personal',
        attachments: [],
        attendees: [],
      },
      {
        event_id: 'ev-workshop',
        summary: 'Client workshop',
        description: 'Signed agenda is attached below.',
        dtstart: at(-5, 13, 0),
        dtend: at(-5, 16, 0),
        status: 'confirmed',
        calendar_id: 'cal-work',
        attendees: [],
        attachments: [
          {
            attachment_id: 'att-workshop-1',
            content_id: 'content-workshop-1',
            role: 'other',
            is_primary: 1,
            media_type: 'application/pdf',
            title: 'workshop-agenda.pdf',
            content_uri: blobUri('content-workshop-1'),
            byte_size: 180_000,
          },
        ],
      },
      {
        event_id: 'ev-physio',
        summary: 'Physio',
        description: '',
        dtstart: at(15, 11, 0),
        dtend: at(15, 11, 45),
        status: 'confirmed',
        calendar_id: 'cal-personal',
        attachments: [],
        attendees: [],
      },
    ];

    // A dense day (+4) for month view's "+N more".
    ['Standup', 'Design sync', 'Investor call', 'Onboarding', 'Wrap-up'].forEach(function (title, i) {
      events.push({
        event_id: 'ev-dense-' + i,
        summary: title + ' (day+4)',
        description: '',
        dtstart: at(4, 9 + i, 0),
        dtend: at(4, 9 + i, 30),
        status: 'confirmed',
        calendar_id: i % 2 === 0 ? 'cal-work' : 'cal-personal',
        attachments: [],
        attendees: [],
      });
    });

    return { calendars: calendars, events: events };
  }

  var agendaStore = appId === 'agenda' ? buildAgendaStore() : null;

  /** Mirrors queries/upcoming.js's window semantics: keep an event that is
   *  still running at `from` even though it started earlier; `to` is an
   *  exclusive upper bound on dtstart. */
  function agendaInRange(ev, from, to) {
    var endMs = new Date(ev.dtend || ev.dtstart).getTime();
    var startMs = new Date(ev.dtstart).getTime();
    if (from) {
      var fromMs = new Date(from).getTime();
      if (endMs < fromMs) return false;
    }
    if (to) {
      var toMs = new Date(to).getTime();
      if (startMs >= toMs) return false;
    }
    return true;
  }

  function agendaTodayStartIso() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  function agendaRead(query, input) {
    if (query === 'upcoming') {
      var from = input.from || agendaTodayStartIso();
      var to = input.to || null;
      var events = agendaStore.events.filter(function (e) {
        return e.status !== 'cancelled' && agendaInRange(e, from, to);
      });
      return { events: events, calendars: agendaStore.calendars };
    }
    if (query === 'search') {
      var term = String(input.term || '')
        .trim()
        .toLowerCase();
      if (!term) return { events: [] };
      var hits = agendaStore.events.filter(function (e) {
        return e.status !== 'cancelled' && (e.summary + ' ' + (e.description || '')).toLowerCase().indexOf(term) !== -1;
      });
      return {
        events: hits.map(function (e) {
          var hay = e.description && e.description.toLowerCase().indexOf(term) !== -1 ? e.description : e.summary;
          var idx = hay.toLowerCase().indexOf(term);
          var snippet = idx === -1 ? '' : '…' + hay.slice(0, idx) + '⟦' + hay.slice(idx, idx + term.length) + '⟧' + hay.slice(idx + term.length) + '…';
          return Object.assign({}, e, { snippet: snippet });
        }),
      };
    }
    console.warn('[mock-centraid] agenda: unmapped query', query);
    return {};
  }

  function agendaWrite(action, input) {
    function findEvent(id) {
      return agendaStore.events.find(function (e) {
        return e.event_id === id;
      });
    }
    function ok(output) {
      return { status: 'executed', invocationId: uid('inv'), receiptId: uid('receipt'), output: output || {} };
    }
    function refuse(reason) {
      return { status: 'failed', reason: reason, predicate: reason };
    }
    function parked() {
      return { status: 'parked', invocationId: uid('inv') };
    }

    switch (action) {
      case 'propose': {
        var summary = String(input.summary || '').trim();
        if (isParkTrigger(summary)) return parked();
        if (/\(conflict\)/i.test(summary)) return refuse('busy_conflict');
        var id = uid('event');
        agendaStore.events.unshift({
          event_id: id,
          summary: summary,
          description: input.description || '',
          dtstart: input.dtstart,
          dtend: input.dtend,
          status: 'tentative',
          calendar_id: input.calendar_id,
          attachments: [],
          attendees: [],
        });
        return ok({ event_id: id });
      }
      case 'reschedule': {
        var e1 = findEvent(input.event_id);
        if (!e1) return refuse('not_found');
        if (isParkTrigger(e1.summary)) return parked();
        e1.dtstart = input.dtstart;
        e1.dtend = input.dtend;
        return ok({ event_id: e1.event_id });
      }
      case 'rsvp': {
        var e2 = findEvent(input.event_id);
        if (!e2) return refuse('not_found');
        if (isParkTrigger(e2.summary)) return parked();
        var att = (e2.attendees || []).find(function (a) {
          return a.party_id === input.party_id;
        });
        if (!att) return refuse('attendee_not_invited');
        att.partstat = input.partstat;
        return ok({ attendee_id: att.party_id, partstat: input.partstat });
      }
      case 'cancel-event': {
        var e3 = findEvent(input.event_id);
        if (!e3) return refuse('not_found');
        // Cancelling is medium-risk in the real vault — it ALWAYS parks for
        // the owner, regardless of the (park) marker (see cancel-event.js).
        return parked();
      }
      case 'attach': {
        var e4 = findEvent(input.subject_id);
        if (!e4) return refuse('not_found');
        if (isParkTrigger(e4.summary)) return parked();
        var contentId = uid('content');
        var attachment = {
          attachment_id: uid('att'),
          content_id: contentId,
          role: input.role || 'other',
          is_primary: 0,
          media_type: 'application/octet-stream',
          title: input.title || 'file',
          content_uri: blobUri(contentId),
          byte_size: 40_000,
        };
        e4.attachments = (e4.attachments || []).concat([attachment]);
        return ok({ attachment_id: attachment.attachment_id });
      }
      case 'detach': {
        var owner = null;
        agendaStore.events.forEach(function (e) {
          var idx = (e.attachments || []).findIndex(function (a) {
            return a.attachment_id === input.attachment_id;
          });
          if (idx !== -1) {
            owner = e;
            e.attachments.splice(idx, 1);
          }
        });
        if (!owner) return refuse('not_found');
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
      if (appId === 'tasks') return tasksRead(opts.query, opts.input || {});
      if (appId === 'notes') return notesRead(opts.query, opts.input || {});
      if (appId === 'agenda') return agendaRead(opts.query, opts.input || {});
      console.warn('[mock-centraid] unknown appId for read()', appId);
      return {};
    },
    async write(opts) {
      opts = opts || {};
      if (DENIED_MODE) return { status: 'denied', reason: 'Grant revoked.' };
      var result = null;
      if (appId === 'docs') result = docsWrite(opts.action, opts.input || {});
      else if (appId === 'photos') result = photosWrite(opts.action, opts.input || {});
      else if (appId === 'tasks') result = tasksWrite(opts.action, opts.input || {});
      else if (appId === 'notes') result = notesWrite(opts.action, opts.input || {});
      else if (appId === 'agenda') result = agendaWrite(opts.action, opts.input || {});
      else console.warn('[mock-centraid] unknown appId for write()', appId);
      if (result == null) {
        console.warn('[mock-centraid] unmapped action, returning {}', opts.action, opts.input);
        return {};
      }
      // A parked write hasn't landed — nothing in the store actually
      // changed, so firing the change bus here would immediately trigger
      // the app's onChange→refresh handler and clear the pending state it
      // just set (tasks treats any change event as "an outstanding parked
      // write may have resolved" — see app.jsx).
      if (result.status !== 'parked') fireChange([appId]);
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
      return appId === 'docs'
        ? docsStore
        : appId === 'photos'
          ? photosStore
          : appId === 'tasks'
            ? tasksStore
            : appId === 'notes'
              ? notesStore
              : appId === 'agenda'
                ? agendaStore
                : null;
    },
    reset() {
      if (appId === 'docs') docsStore = buildDocsStore();
      else if (appId === 'photos') photosStore = buildPhotosStore();
      else if (appId === 'tasks') tasksStore = buildTasksStore();
      else if (appId === 'notes') notesStore = buildNotesStore();
      else if (appId === 'agenda') agendaStore = buildAgendaStore();
      fireChange([appId]);
    },
    fireChange: fireChange,
  };

  console.info(
    '[mock-centraid] armed for app=' + appId + (EMPTY_MODE ? ' (empty)' : '') + (DENIED_MODE ? ' (denied)' : ''),
  );
})();
