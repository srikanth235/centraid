// governance: allow-repo-hygiene file-size-limit (#363) mock fixture data for every blueprint app's queries/actions, never shipped — see the header below
// MOCK window.centraid — visual-verification harness only, never shipped.
//
// Replaces the runtime's real change-bridge `window.centraid.read/write` (which
// POST to /centraid/<appId>/{queries,actions}/* against a live vault) with an in-page fixture
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
  // A real fetchable data: URI for a text version's bytes — unlike blobUri()
  // above (whose GET route always returns a placeholder SVG, real bytes
  // never persisted), so the docs app's in-place editor can genuinely
  // `fetch(...).then(r => r.text())` its way to a version's actual content
  // under the mock, not just an image.
  function textDataUri(mediaType, text) {
    return 'data:' + mediaType + ';charset=utf-8,' + encodeURIComponent(text);
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
  // (bridge-script.ts's injectChangeBridge), but fired directly in-page
  // instead of over an SSE round trip. Since issue #404 seven apps subscribe
  // through the kit's `onDataChange(tables, cb)`, which filters on the
  // event's `tables`: a NON-EMPTY list must intersect the app's declared
  // tables, while an EMPTY list always fires (production emits `[]` for an
  // app's own handler writes). `fireChange([])` below therefore matches
  // production semantics; see window.__fixtures for a manual trigger.
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
  // Docs fixtures — a document is a core.document WRAPPER around a content
  // item (issue #352), so every fixture row carries both a document_id
  // (identity — selection/details/quick-look key off this) and a content_id
  // (the CURRENT version's bytes — blob/preview URLs key off this instead).
  // Each fixture doc also keeps a private `__versions` array (newest
  // first, `current: true` on entry 0) that queries/history.js's own
  // walk-and-honestly-order-by-assertion-time shape mirrors — see
  // packages/blueprints/apps/docs/queries/{drive,search,history}.js for the
  // real row shapes and app.json for the folders-scheme model
  // (folder_id/name/parent_id, root implied by null).
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
      var contentId = id + '-c1';
      var createdAt = isoDaysAgo(days);
      var base = {
        document_id: id,
        content_id: contentId,
        title: title,
        media_type: mediaType,
        byte_size: bytes,
        content_uri: blobUri(contentId),
        created_at: createdAt,
        updated_at: createdAt,
        folder_id: folderId,
        starred: false,
        trashed: false,
        purge_at: null,
      };
      var merged = Object.assign(base, extra || {});
      merged.__versions = [
        {
          content_id: merged.content_id,
          media_type: merged.media_type,
          byte_size: merged.byte_size,
          content_uri: merged.content_uri,
          asserted_at: merged.created_at,
          current: true,
        },
      ];
      return merged;
    }

    // A text-editable document with real edit history — the one fixture the
    // Edit affordance and the version-history panel both have something
    // honest to show against (three real bodies, oldest to newest, each a
    // fetchable data: URI so the editor's own `fetch(...).then(r=>r.text())`
    // load actually works under the mock, not just the placeholder SVG the
    // blob route serves for every other media type).
    var packingBodies = [
      ['doc-16-c1', 'Packing list\n- Passport\n- Chargers\n', 20],
      ['doc-16-c2', 'Packing list\n- Passport\n- Chargers\n- Sunscreen\n', 8],
      ['doc-16-c3', 'Packing list\n- Passport\n- Chargers\n- Sunscreen\n- Adapter\n', 1],
    ];
    var packingVersions = packingBodies
      .map(function (row) {
        var text = row[1];
        return {
          content_id: row[0],
          media_type: 'text/plain',
          byte_size: text.length,
          content_uri: textDataUri('text/plain', text),
          asserted_at: isoDaysAgo(row[2]),
        };
      })
      .reverse(); // newest first, matching queries/history.js's own order
    packingVersions[0].current = true;
    var packingDoc = {
      document_id: 'doc-16',
      content_id: packingVersions[0].content_id,
      title: 'Packing list.txt',
      media_type: 'text/plain',
      byte_size: packingVersions[0].byte_size,
      content_uri: packingVersions[0].content_uri,
      created_at: isoDaysAgo(20),
      updated_at: isoDaysAgo(1),
      folder_id: null,
      starred: false,
      trashed: false,
      purge_at: null,
      __versions: packingVersions,
    };

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
      packingDoc,
    ];

    // Free-form labels + the blob custody projection (issue #352 phase 4) —
    // see packages/blueprints/apps/docs/queries/{drive,search}.js for the
    // real per-document shape. Custody cycles through all four states (the
    // same trick the photos fixture uses) so every badge tone renders
    // somewhere; a handful of docs also carry hand-picked labels so the
    // toolbar's tag-filter chips have something real to show.
    // core.tag_item's edges carry a tag_id (untag.js removes by tag_id, not
    // label) — each fixture label gets a stable synthetic id.
    function docLabelTags(documentId, labels) {
      return labels.map(function (label) {
        return { tag_id: 'tag-' + documentId + '-' + label, label: label };
      });
    }
    var tagsByDoc = {
      'doc-1': docLabelTags('doc-1', ['lease', '2024']),
      'doc-3': docLabelTags('doc-3', ['taxes']),
      'doc-4': docLabelTags('doc-4', ['taxes', 'receipts']),
      'doc-6': docLabelTags('doc-6', ['taxes']),
      'doc-9': docLabelTags('doc-9', ['travel']),
      'doc-16': docLabelTags('doc-16', ['travel']),
    };
    var custodyStates = ['replicated', 'local-only', 'remote-only', 'missing'];
    documents.forEach(function (d, i) {
      d.tags = tagsByDoc[d.document_id] || [];
      d.custody_state = custodyStates[i % custodyStates.length];
    });

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
    if (query === 'history') {
      var hd = docsStore.documents.find(function (d) {
        return d.document_id === input.document_id;
      });
      if (!hd) return { versions: [] };
      var versions = (hd.__versions || []).map(function (v, i) {
        return {
          content_id: v.content_id,
          media_type: v.media_type,
          byte_size: v.byte_size,
          content_uri: v.content_uri,
          current: i === 0,
          asserted_at: v.asserted_at,
        };
      });
      return { versions: versions };
    }
    if (query === 'activity') {
      // Synthesizes what queries/activity.js's real consent.provenance read
      // would return — see that file's own header for the exact row shape
      // (`activity`/`agent_kind`/`occurred_at`). Not stored on the fixture
      // doc itself (unlike tags/__versions): derived fresh from whatever the
      // doc looks like right now, newest first, so a mock write (star, edit,
      // tag…) that ran during this session shows up here too.
      var ad = docsStore.documents.find(function (d) {
        return d.document_id === input.document_id;
      });
      if (!ad) return { events: [] };
      var events = [
        { activity: 'command.core.add_document', agent_kind: 'owner', occurred_at: ad.created_at },
      ];
      if (ad.folder_id) {
        events.push({
          activity: 'command.core.move_document',
          agent_kind: 'app',
          occurred_at: ad.created_at,
        });
      }
      if (ad.starred) {
        events.push({
          activity: 'command.core.star_document',
          agent_kind: 'ai_agent',
          occurred_at: ad.updated_at,
        });
      }
      // One edit/replace event per version beyond the original upload (every
      // __versions entry except the LAST — newest-first, the last is the
      // original add_document upload, already covered above), dated by that
      // version's own asserted_at (mirroring the real vault's revises-link
      // ordering, queries/history.js's header comment).
      var editedVersions = (ad.__versions || []).slice(0, -1);
      editedVersions.forEach(function (v) {
        events.push({
          activity: /^text\//i.test(ad.media_type || '')
            ? 'command.core.edit_document'
            : 'command.core.replace_document_content',
          agent_kind: 'owner',
          occurred_at: v.asserted_at,
        });
      });
      events.sort(function (a, b) {
        return String(b.occurred_at || '').localeCompare(String(a.occurred_at || ''));
      });
      return { events: events };
    }
    console.warn('[mock-centraid] docs: unmapped query', query);
    return {};
  }

  function docsWrite(action, input) {
    var docs = docsStore.documents;
    var folders = docsStore.folders;
    function findDoc(id) {
      return docs.find(function (d) {
        return d.document_id === id;
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
    // A new version, unshifted onto __versions (newest first) — the shared
    // tail of edit/replace/restore-version below, mirroring how the real
    // vault always repoints current_content_id AND records a fresh
    // `revises` link, never mutating an existing one.
    function pushVersion(d, version) {
      (d.__versions || []).forEach(function (v) {
        v.current = false;
      });
      version.current = true;
      d.__versions = [version].concat(d.__versions || []);
      d.content_id = version.content_id;
      d.content_uri = version.content_uri;
      d.media_type = version.media_type;
      d.byte_size = version.byte_size;
      d.updated_at = version.asserted_at;
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
        var contentId = id + '-c1';
        var nowIso = new Date().toISOString();
        var newDoc = {
          document_id: id,
          content_id: contentId,
          title: title,
          media_type: mediaType,
          byte_size: input.data_uri ? Math.round((input.data_uri.length * 3) / 4) : 256_000,
          content_uri: blobUri(contentId),
          created_at: nowIso,
          updated_at: nowIso,
          folder_id: input.folder_id != null ? String(input.folder_id) : null,
          starred: false,
          trashed: false,
          purge_at: null,
          tags: [],
          custody_state: 'local-only',
        };
        newDoc.__versions = [
          {
            content_id: contentId,
            media_type: mediaType,
            byte_size: newDoc.byte_size,
            content_uri: newDoc.content_uri,
            asserted_at: nowIso,
            current: true,
          },
        ];
        docs.unshift(newDoc);
        return ok({ document_id: id, content_id: contentId, deduped: false });
      }
      case 'rename': {
        var d1 = findDoc(input.document_id);
        if (!d1) return refuse('not_found');
        if (d1.trashed) return refuse('document_trashed');
        d1.title = String(input.title);
        return ok({ document_id: d1.document_id });
      }
      case 'move': {
        var d2 = findDoc(input.document_id);
        if (!d2) return refuse('not_found');
        d2.folder_id = input.folder_id != null ? String(input.folder_id) : null;
        return ok({ document_id: d2.document_id });
      }
      case 'trash': {
        var d3 = findDoc(input.document_id);
        if (!d3) return refuse('not_found');
        d3.trashed = true;
        d3.purge_at = isoDaysFromNow(30);
        return ok({ document_id: d3.document_id, purge_at: d3.purge_at });
      }
      case 'restore': {
        var d4 = findDoc(input.document_id);
        if (!d4) return refuse('not_found');
        d4.trashed = false;
        d4.purge_at = null;
        return ok({ document_id: d4.document_id });
      }
      case 'star': {
        var d5 = findDoc(input.document_id);
        if (!d5) return refuse('not_found');
        if (d5.trashed) return refuse('document_trashed');
        d5.starred = true;
        return ok({ document_id: d5.document_id });
      }
      case 'unstar': {
        var d6 = findDoc(input.document_id);
        if (!d6) return refuse('not_found');
        if (d6.trashed) return refuse('document_trashed');
        d6.starred = false;
        return ok({ document_id: d6.document_id });
      }
      case 'edit': {
        var d7 = findDoc(input.document_id);
        if (!d7) return refuse('not_found');
        if (d7.trashed) return refuse('document_trashed');
        if (!/^text\//i.test(d7.media_type || '')) return refuse('current_content_is_text');
        var bodyText = String(input.body_text || '');
        var newContentId7 = d7.document_id + '-c' + ((d7.__versions || []).length + 1);
        pushVersion(d7, {
          content_id: newContentId7,
          media_type: d7.media_type,
          byte_size: bodyText.length,
          content_uri: textDataUri(d7.media_type, bodyText),
          asserted_at: new Date().toISOString(),
        });
        if (input.title != null) d7.title = String(input.title);
        return ok({ document_id: d7.document_id, content_id: newContentId7 });
      }
      case 'replace': {
        var d8 = findDoc(input.document_id);
        if (!d8) return refuse('not_found');
        if (d8.trashed) return refuse('document_trashed');
        var newContentId8 = d8.document_id + '-c' + ((d8.__versions || []).length + 1);
        pushVersion(d8, {
          content_id: newContentId8,
          media_type: d8.media_type,
          byte_size: input.data_uri ? Math.round((input.data_uri.length * 3) / 4) : 256_000,
          content_uri: blobUri(newContentId8),
          asserted_at: new Date().toISOString(),
        });
        if (input.title != null) d8.title = String(input.title);
        return ok({ document_id: d8.document_id, content_id: newContentId8 });
      }
      case 'restore-version': {
        var d9 = findDoc(input.document_id);
        if (!d9) return refuse('not_found');
        var versions9 = d9.__versions || [];
        var idx9 = versions9.findIndex(function (v) {
          return v.content_id === input.content_id;
        });
        if (idx9 === -1) return refuse('target_in_chain');
        if (idx9 === 0) return refuse('not_already_current');
        var restored9 = versions9.splice(idx9, 1)[0];
        pushVersion(d9, {
          content_id: restored9.content_id,
          media_type: restored9.media_type,
          byte_size: restored9.byte_size,
          content_uri: restored9.content_uri,
          asserted_at: new Date().toISOString(),
        });
        return ok({ document_id: d9.document_id, content_id: restored9.content_id });
      }
      case 'tag': {
        var dTag = findDoc(input.document_id);
        if (!dTag) return refuse('not_found');
        var label = String(input.label || '')
          .trim()
          .toLowerCase();
        if (!label) return refuse('label_not_blank');
        if (!dTag.tags) dTag.tags = [];
        var existingTag = dTag.tags.find(function (t) {
          return t.label === label;
        });
        if (!existingTag) dTag.tags.push({ tag_id: uid('tag'), label: label });
        return ok({ document_id: dTag.document_id });
      }
      case 'untag': {
        // core.untag_item removes by tag_id alone (no document_id sent) —
        // find whichever document currently owns this edge.
        var dUntag = docs.find(function (d) {
          return (d.tags || []).some(function (t) {
            return t.tag_id === input.tag_id;
          });
        });
        if (!dUntag) return refuse('not_found');
        dUntag.tags = dUntag.tags.filter(function (t) {
          return t.tag_id !== input.tag_id;
        });
        return ok({ tag_id: input.tag_id });
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
    if (EMPTY_MODE) {
      return {
        assets: [],
        trash: [],
        albums: [],
        faceRegions: [],
        people: [],
        places: [],
        phash: [],
        enrichmentTier: 'local',
      };
    }

    var people = [
      { party_id: 'party-mia', name: 'Mia' },
      { party_id: 'party-sam', name: 'Sam' },
      { party_id: 'party-ravi', name: 'Ravi' },
    ];

    var albums = [
      { album_id: 'album-trip', title: 'Summer Trip', cover_content_id: null },
      { album_id: 'album-family', title: 'Family', cover_content_id: null },
      { album_id: 'album-studio', title: 'Studio work', cover_content_id: null },
    ];
    var tripMembers = [
      'asset-2',
      'asset-5',
      'asset-8',
      'asset-11',
      'asset-14',
      'asset-17',
      'asset-23',
      'asset-31',
    ];
    var familyMembers = ['asset-3', 'asset-6', 'asset-9', 'asset-12', 'asset-28', 'asset-40'];
    var studioMembers = ['asset-45', 'asset-48', 'asset-52', 'asset-55'];

    // Issue #352 phase 3/4 fixtures — geolocation, free-form tags, custody.
    var places = [
      { place_id: 'place-cafe', name: 'Blue Bottle Cafe' },
      { place_id: 'place-park', name: 'Golden Gate Park' },
      { place_id: 'place-coast', name: 'Half Moon Bay' },
    ];
    var placeByAsset = {
      'asset-2': places[0],
      'asset-5': places[1],
      'asset-9': places[0],
      'asset-23': places[2],
      'asset-31': places[2],
    };
    // core.tag_item's edges carry a tag_id (untag-asset.js removes by
    // tag_id, not label) — each fixture label gets a stable synthetic id.
    function labelTags(assetId, labels) {
      return labels.map(function (label) {
        return { tag_id: 'tag-' + assetId + '-' + label, label: label };
      });
    }
    var tagsByAsset = {
      'asset-2': labelTags('asset-2', ['beach', 'family']),
      'asset-5': labelTags('asset-5', ['hike']),
      'asset-8': labelTags('asset-8', ['family']),
      'asset-11': labelTags('asset-11', ['beach']),
      'asset-14': labelTags('asset-14', ['sunset']),
      'asset-23': labelTags('asset-23', ['coast', 'beach']),
      'asset-45': labelTags('asset-45', ['work']),
    };
    // Cycles through all four custody states so every badge tone renders
    // somewhere in the fixture.
    var custodyStates = ['replicated', 'local-only', 'remote-only', 'missing'];
    // A spread of real-ish aspect ratios (landscape 4:3, portrait 3:4,
    // square, wide 16:9, ultra-wide panorama) so the justified timeline has
    // genuinely varying row shapes to pack, not a rigid square grid —
    // cycled per asset, independent of month/album/kind.
    var aspects = [
      { width: 1600, height: 1200 }, // 4:3 landscape
      { width: 1200, height: 1600 }, // 3:4 portrait
      { width: 1400, height: 1400 }, // square
      { width: 1920, height: 1080 }, // 16:9 wide
      { width: 2400, height: 1000 }, // panorama
      { width: 1000, height: 1500 }, // tall portrait
    ];

    var assets = [];
    var ASSET_COUNT = 58;
    for (var i = 1; i <= ASSET_COUNT; i += 1) {
      var monthsBack = i % 6; // 6 distinct months
      var day = ((i * 3) % 27) + 1;
      var d = new Date();
      d.setMonth(d.getMonth() - monthsBack);
      d.setDate(day);
      d.setHours(9 + (i % 10), (i * 7) % 60, 0, 0);
      var isVideo = i % 11 === 0;
      var id = 'asset-' + i;
      var albumIds = [];
      if (tripMembers.indexOf(id) !== -1) albumIds.push('album-trip');
      if (familyMembers.indexOf(id) !== -1) albumIds.push('album-family');
      if (studioMembers.indexOf(id) !== -1) albumIds.push('album-studio');
      // A multiplicative hash (not a plain `% aspects.length`) decorrelates
      // the aspect pick from the day-bucket arithmetic above — day/month
      // both derive from `i` via small-modulus formulas, so any linear
      // function of `i` stays periodic with them and every asset on the
      // same day ends up with the same aspect, defeating the point of a
      // justified (not rigid-grid) timeline.
      var aspectIdx = ((i * 2654435761) >>> 0) % aspects.length;
      var dims = isVideo ? { width: 1920, height: 1080 } : aspects[aspectIdx];
      assets.push({
        asset_id: id,
        content_id: 'content-' + id,
        kind: isVideo ? 'video' : 'photo',
        media_type: isVideo ? 'video/mp4' : 'image/jpeg',
        title: (isVideo ? 'MOV_' : 'IMG_') + (1000 + i) + (isVideo ? '.mp4' : '.jpg'),
        content_uri: blobUri('content-' + id),
        thumb_uri: blobUri('content-' + id) + '?variant=thumb',
        byte_size: isVideo ? 24_000_000 : 2_400_000 + i * 10_000,
        width: dims.width,
        height: dims.height,
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
        place: placeByAsset[id] || null,
        tags: tagsByAsset[id] || [],
        custody_state: custodyStates[i % custodyStates.length],
      });
    }

    // Two trashed assets (ids beyond the live range above so they never
    // collide with a live asset_id), split out of the live window like the
    // real `library` query's separate `trash` array.
    var trash = [ASSET_COUNT + 1, ASSET_COUNT + 2].map(function (n) {
      var id = 'asset-' + n;
      var purgeInDays = n === ASSET_COUNT + 1 ? 20 : 25;
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

    // Phash near-duplicate clusters (issue #352 phase 3/4): a 2-way and a
    // 3-way cluster among the live assets, mirroring
    // media_asset_phash.cluster_id's shape (asset_id -> cluster_id, the
    // group's lowest asset_id by convention — not load-bearing for the
    // mock, just documentary).
    var phash = [
      { asset_id: 'asset-3', cluster_id: 'asset-3' },
      { asset_id: 'asset-7', cluster_id: 'asset-3' },
      { asset_id: 'asset-10', cluster_id: 'asset-10' },
      { asset_id: 'asset-15', cluster_id: 'asset-10' },
      { asset_id: 'asset-19', cluster_id: 'asset-10' },
    ];

    return {
      assets: assets,
      trash: trash,
      albums: albums,
      faceRegions: faceRegions,
      people: people,
      places: places,
      phash: phash,
      enrichmentTier: 'local',
    };
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
        places: photosStore.places,
        trash: trash,
        truncated: live.length > limit,
        window: limit,
      };
    }
    if (query === 'search') {
      var term2 = String(input.term || '')
        .trim()
        .toLowerCase();
      if (!term2) return { assets: [] };
      var matches = photosStore.assets.filter(function (a) {
        return (
          String(a.title || '')
            .toLowerCase()
            .indexOf(term2) !== -1
        );
      });
      return { assets: matches };
    }
    if (query === 'duplicates') {
      var byCluster = {};
      photosStore.phash.forEach(function (p) {
        var asset = photosStore.assets.find(function (a) {
          return a.asset_id === p.asset_id;
        });
        if (!asset) return; // trashed/missing members drop out, same as the real query
        if (!byCluster[p.cluster_id]) byCluster[p.cluster_id] = [];
        byCluster[p.cluster_id].push(asset);
      });
      var clusters = Object.keys(byCluster)
        .map(function (key) {
          return { key: key, tier: 'phash', assets: byCluster[key] };
        })
        .filter(function (c) {
          return c.assets.length >= 2;
        });
      clusters.sort(function (a, b) {
        return b.assets.length - a.assets.length;
      });
      return { clusters: clusters };
    }
    if (query === 'enrichment-status') {
      return { tier: photosStore.enrichmentTier };
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
      case 'set-place': {
        var a4 = findAsset(input.asset_id);
        if (!a4) return refuse('not_found');
        if (input.place_id) {
          var place = photosStore.places.find(function (p) {
            return p.place_id === input.place_id;
          });
          if (!place) return refuse('place_not_found');
          a4.place = place;
        } else {
          a4.place = null;
        }
        return ok({ asset_id: a4.asset_id, place_id: a4.place ? a4.place.place_id : null });
      }
      case 'tag-asset': {
        var a5 = findAsset(input.asset_id);
        if (!a5) return refuse('not_found');
        var label = String(input.label || '')
          .trim()
          .toLowerCase();
        if (!label) return refuse('label_not_blank');
        if (!a5.tags) a5.tags = [];
        var existingAssetTag = a5.tags.find(function (t) {
          return t.label === label;
        });
        if (!existingAssetTag) a5.tags.push({ tag_id: uid('tag'), label: label });
        return ok({ asset_id: a5.asset_id });
      }
      case 'untag-asset': {
        // core.untag_item removes by tag_id alone (no asset_id sent) — find
        // whichever asset currently owns this edge.
        var a6 = assets.find(function (a) {
          return (a.tags || []).some(function (t) {
            return t.tag_id === input.tag_id;
          });
        });
        if (!a6) return refuse('not_found');
        a6.tags = a6.tags.filter(function (t) {
          return t.tag_id !== input.tag_id;
        });
        return ok({ tag_id: input.tag_id });
      }
      case 'request-enrichment': {
        if (photosStore.enrichmentTier === 'off') return refuse('enrichment_off');
        return ok({ request_id: uid('req') });
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
          opts.completedAt !== undefined
            ? opts.completedAt == null
              ? null
              : dayKey(opts.completedAt)
            : null,
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
      task('task-later-2-sub-1', 'Reserve the cabin', {
        status: 'completed',
        parent: 'task-later-2',
      }),
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
          var snippet =
            t.description && t.description.toLowerCase().indexOf(term) !== -1
              ? '…⟦' + t.description + '⟧…'
              : '';
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
      return {
        status: 'executed',
        invocationId: uid('inv'),
        receiptId: uid('receipt'),
        output: output || {},
      };
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
        t1.completed_at =
          input.status === 'completed' || input.status === 'cancelled' ? dayKey(0) : null;
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
          var snippet =
            n.body.toLowerCase().indexOf(term) !== -1 ? '…⟦' + n.body.slice(0, 80) + '⟧…' : '';
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
      return {
        status: 'executed',
        invocationId: uid('inv'),
        receiptId: uid('receipt'),
        output: output || {},
      };
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
        notesStore.notebooks.push({
          notebook_id: nbId,
          name: name,
          sort_order: notesStore.notebooks.length,
        });
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
        attendees: [
          you,
          guest('p-sam', 'Sam Cole', 'accepted'),
          guest('p-dana', 'Dana Ruiz', 'declined'),
        ],
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
        attendees: [
          you,
          guest('p-sam', 'Sam Cole', 'accepted'),
          guest('p-priya', 'Priya Nair', 'declined'),
        ],
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
    ['Standup', 'Design sync', 'Investor call', 'Onboarding', 'Wrap-up'].forEach(
      function (title, i) {
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
      },
    );

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
        return (
          e.status !== 'cancelled' &&
          (e.summary + ' ' + (e.description || '')).toLowerCase().indexOf(term) !== -1
        );
      });
      return {
        events: hits.map(function (e) {
          var hay =
            e.description && e.description.toLowerCase().indexOf(term) !== -1
              ? e.description
              : e.summary;
          var idx = hay.toLowerCase().indexOf(term);
          var snippet =
            idx === -1
              ? ''
              : '…' +
                hay.slice(0, idx) +
                '⟦' +
                hay.slice(idx, idx + term.length) +
                '⟧' +
                hay.slice(idx + term.length) +
                '…';
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
      return {
        status: 'executed',
        invocationId: uid('inv'),
        receiptId: uid('receipt'),
        output: output || {},
      };
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
          rrule: input.rrule || null,
          conferencing_uri: input.conferencing_uri || null,
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
  // People fixtures — see packages/blueprints/apps/people/queries/people.js
  // for the list-row shape (party_id/name/role/avatar_color/cadence_days/
  // last_contacted_at/created_at/circle_id/starred/reminders), person.js for
  // the full-profile shape (met/contact/relationships/dates/notes/tasks/
  // gifts/debts/interactions), dashboard.js (reconnect/upcoming/recent/
  // counts), journal.js (owner 'entry' rows folded with 'auto' interaction
  // rows) and search.js (people-row + snippet, reminders ALWAYS [] — the
  // real query never re-fetches dates, replicated here on purpose). The
  // store keeps one superset row per person and projects per query. Seed
  // names/interactions come from apps/people/seed.js; circles, favorites,
  // relationships, journal entries etc. are invented (seed.js has none).
  // "(park)" in any typed text — or in the target person's name — parks the
  // write, same convention as tasks/notes/agenda.
  // ---------------------------------------------------------------------
  function buildPeopleStore() {
    if (EMPTY_MODE) return { circles: [], people: [], journal: [] };

    var circles = [
      { circle_id: 'circle-college', name: 'College' },
      { circle_id: 'circle-family', name: 'Family' },
      { circle_id: 'circle-work', name: 'Work' },
    ];

    function person(id, name, opts) {
      opts = opts || {};
      return {
        party_id: id,
        name: name,
        role: opts.role || '',
        avatar_color: opts.avatar_color || null,
        cadence_days: opts.cadence_days || 30,
        last_contacted_at: opts.lastDays == null ? null : isoDaysAgo(opts.lastDays),
        created_at: isoDaysAgo(opts.createdDays != null ? opts.createdDays : 120),
        met: opts.met || '',
        circle_id: opts.circle_id || null,
        starred: !!opts.starred,
        contact: opts.contact || [],
        relationships: opts.relationships || [],
        dates: opts.dates || [],
        notes: opts.notes || [],
        tasks: opts.tasks || [],
        gifts: opts.gifts || [],
        debts: opts.debts || [], // open debts only — settle-debt removes the row
        interactions: opts.interactions || [],
      };
    }

    var people = [
      // The rich profile — every drawer section populated.
      person('party-dadu', 'Dadu', {
        role: 'Grandfather',
        avatar_color: '#E89A3C',
        cadence_days: 7,
        lastDays: 2,
        createdDays: 400,
        circle_id: 'circle-family',
        starred: true,
        met: 'Family — my mother’s father.',
        contact: [
          { kind: 'phone', value: '+91 98400 22110' },
          { kind: 'email', value: 'dadu.letters@gmail.com' },
        ],
        relationships: [
          { relationship_id: 'rel-dadu-1', name: 'Nani', kind: 'Spouse', pet: null },
          { relationship_id: 'rel-dadu-2', name: 'Laddu', kind: 'Pet', pet: 'dog' },
        ],
        dates: [
          { date_id: 'date-dadu-bday', label: 'Birthday', month_day: '08-14', reminder_on: true },
          {
            date_id: 'date-dadu-anniv',
            label: 'Anniversary',
            month_day: '02-21',
            reminder_on: false,
          },
        ],
        notes: [
          {
            annotation_id: 'note-dadu-1',
            text: 'Retold the Marina Beach story again — third time, still funnier every telling.',
            created_at: isoDaysAgo(2, 15),
          },
          {
            annotation_id: 'note-dadu-2',
            text: 'Wants large-print books only now. Eyes tire after a page of normal type.',
            created_at: isoDaysAgo(20, 11),
          },
        ],
        tasks: [
          { task_id: 'task-dadu-1', text: 'Fix the font size on his tablet', done: false },
          { task_id: 'task-dadu-2', text: 'Send the Ooty photos', done: true },
        ],
        gifts: [
          { gift_id: 'gift-dadu-1', text: 'Large-print edition of Malgudi Days', state: 'idea' },
          { gift_id: 'gift-dadu-2', text: 'Wool shawl from the hill market', state: 'given' },
        ],
        interactions: [
          {
            interaction_id: 'int-dadu-1',
            kind: 'visit',
            text: 'Sunday lunch. BP is under control again; he beat me at carrom twice.',
            occurred_at: isoDaysAgo(2, 13),
          },
          {
            interaction_id: 'int-dadu-2',
            kind: 'call',
            text: 'Reminded him about the eye check-up on Thursday.',
            occurred_at: isoDaysAgo(9, 18),
          },
        ],
      }),
      person('party-meera', 'Meera Pillai', {
        role: 'College friend',
        avatar_color: '#7C5BD9',
        cadence_days: 30,
        lastDays: 12,
        createdDays: 300,
        circle_id: 'circle-college',
        dates: [
          { date_id: 'date-meera-bday', label: 'Birthday', month_day: '11-02', reminder_on: true },
        ],
        interactions: [
          {
            interaction_id: 'int-meera-1',
            kind: 'call',
            text: 'Caught up about her Pune move; she wants the Goa dates.',
            occurred_at: isoDaysAgo(12, 19),
          },
        ],
      }),
      // Overdue — cadence 45, last spoke 60 days ago (Reconnect material).
      person('party-arjun', 'Arjun Rao', {
        role: 'Flatmate from Bangalore days',
        avatar_color: '#2EA098',
        cadence_days: 45,
        lastDays: 60,
        createdDays: 350,
        circle_id: 'circle-college',
        debts: [
          {
            debt_id: 'debt-arjun-1',
            direction: 'owe',
            amount_minor: 120000,
            currency: 'USD',
            reason: 'His half of the deposit refund',
          },
        ],
        interactions: [
          {
            interaction_id: 'int-arjun-1',
            kind: 'message',
            text: 'Split the deposit refund; still owe him his half.',
            occurred_at: isoDaysAgo(60, 10),
          },
        ],
      }),
      // Due soon — 50 of 60 cadence days elapsed.
      person('party-sana', 'Sana Qureshi', {
        role: 'Design lead, ex-colleague',
        avatar_color: '#E0567A',
        cadence_days: 60,
        lastDays: 50,
        createdDays: 500,
        circle_id: 'circle-work',
        starred: true,
        gifts: [{ gift_id: 'gift-sana-1', text: 'Fountain pen ink sampler', state: 'idea' }],
        interactions: [
          {
            interaction_id: 'int-sana-1',
            kind: 'message',
            text: 'Sent the portfolio feedback she asked for.',
            occurred_at: isoDaysAgo(50, 16),
          },
        ],
      }),
      // No circle, no stored avatar colour (exercises the hash fallback),
      // never contacted (daysSince counts from created_at).
      person('party-ravi', 'Ravi Menon', {
        role: 'Neighbour',
        cadence_days: 90,
        createdDays: 25,
      }),
      // "(park)" in the NAME: every write targeting this person parks —
      // the reliable way to see the pending treatment from the drawer.
      person('party-priya', 'Priya Nair (park)', {
        role: 'Mentor',
        avatar_color: '#4E68DD',
        cadence_days: 21,
        lastDays: 30,
        createdDays: 200,
        circle_id: 'circle-work',
      }),
    ];

    var journal = [
      {
        entry_id: 'jr-1',
        mood: '🙂',
        text: 'Long walk after the standup. Called Dadu on the way back.',
        entry_date: dayKey(0),
        created_at: isoDaysAgo(0, 20),
      },
      {
        entry_id: 'jr-2',
        mood: '😄',
        text: 'Meera confirmed the Goa dates. December, finally.',
        entry_date: dayKey(-3),
        created_at: isoDaysAgo(3, 21),
      },
    ];

    return { circles: circles, people: people, journal: journal };
  }

  var peopleStore = appId === 'people' ? buildPeopleStore() : null;

  function peopleDaysSince(iso) {
    var t = new Date(iso).getTime();
    return isNaN(t) ? 0 : Math.max(0, Math.floor((Date.now() - t) / 86400000));
  }
  // Days until the next annual MM-DD from today (0 = today) — mirrors
  // queries/dashboard.js's daysUntilMonthDay.
  function peopleDaysUntil(monthDay) {
    var parts = String(monthDay).split('-');
    var mo = Number(parts[0]);
    var da = Number(parts[1]);
    if (!mo || !da) return 9999;
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var next = new Date(now.getFullYear(), mo - 1, da);
    if (next < today) next = new Date(now.getFullYear() + 1, mo - 1, da);
    return Math.round((next - today) / 86400000);
  }
  function peopleRow(p) {
    return {
      party_id: p.party_id,
      name: p.name,
      role: p.role,
      avatar_color: p.avatar_color,
      cadence_days: p.cadence_days,
      last_contacted_at: p.last_contacted_at,
      created_at: p.created_at,
      circle_id: p.circle_id,
      starred: p.starred,
      reminders: p.dates
        .filter(function (d) {
          return d.reminder_on;
        })
        .map(function (d) {
          return { date_id: d.date_id, label: d.label, month_day: d.month_day };
        }),
    };
  }
  function peopleCard(p) {
    return { party_id: p.party_id, name: p.name, avatar_color: p.avatar_color, role: p.role };
  }

  function peopleRead(query, input) {
    var sortedCircles = peopleStore.circles.slice().sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name));
    });
    if (query === 'people') {
      var limit = Math.min(Math.max(Number(input.limit) || 200, 20), 2000);
      return {
        people: peopleStore.people.slice(0, limit).map(peopleRow),
        circles: sortedCircles,
        truncated: peopleStore.people.length >= limit,
        window: limit,
      };
    }
    if (query === 'person') {
      var p = peopleStore.people.find(function (x) {
        return x.party_id === String(input.party_id || '');
      });
      if (!p) return { person: null };
      return {
        person: {
          party_id: p.party_id,
          name: p.name,
          role: p.role,
          avatar_color: p.avatar_color,
          cadence_days: p.cadence_days,
          last_contacted_at: p.last_contacted_at,
          created_at: p.created_at,
          met: p.met,
          circle_id: p.circle_id,
          starred: p.starred,
          contact: p.contact,
          relationships: p.relationships,
          dates: p.dates,
          notes: p.notes,
          tasks: p.tasks,
          gifts: p.gifts,
          debts: p.debts,
          interactions: p.interactions,
        },
      };
    }
    if (query === 'dashboard') {
      var reconnect = peopleStore.people
        .map(function (px) {
          return {
            p: px,
            over: peopleDaysSince(px.last_contacted_at || px.created_at) - px.cadence_days,
          };
        })
        .filter(function (x) {
          return x.over >= 0;
        })
        .sort(function (a, b) {
          return b.over - a.over;
        })
        .map(function (x) {
          return peopleCard(x.p);
        });
      var upcoming = [];
      peopleStore.people.forEach(function (px) {
        px.dates.forEach(function (d) {
          if (!d.reminder_on) return;
          upcoming.push(
            Object.assign({}, peopleCard(px), {
              date_id: d.date_id,
              label: d.label,
              month_day: d.month_day,
              until: peopleDaysUntil(d.month_day),
            }),
          );
        });
      });
      upcoming.sort(function (a, b) {
        return a.until - b.until;
      });
      upcoming.forEach(function (u) {
        delete u.until;
      });
      var recent = [];
      peopleStore.people.forEach(function (px) {
        px.interactions.forEach(function (i) {
          recent.push(
            Object.assign({}, peopleCard(px), {
              interaction_id: i.interaction_id,
              kind: i.kind,
              text: i.text,
              occurred_at: i.occurred_at,
            }),
          );
        });
      });
      recent.sort(function (a, b) {
        return String(b.occurred_at).localeCompare(String(a.occurred_at));
      });
      var starredCount = peopleStore.people.filter(function (px) {
        return px.starred;
      }).length;
      return {
        reconnect: reconnect,
        upcoming: upcoming,
        recent: recent.slice(0, 30),
        counts: {
          all: peopleStore.people.length,
          reconnect: reconnect.length,
          upcoming: upcoming.length,
          starred: starredCount,
        },
      };
    }
    if (query === 'journal') {
      var owner = peopleStore.journal.map(function (e) {
        return {
          kind: 'entry',
          id: e.entry_id,
          sort_at: e.created_at,
          date: e.entry_date,
          mood: e.mood,
          text: e.text,
        };
      });
      var auto = [];
      peopleStore.people.forEach(function (px) {
        px.interactions.forEach(function (i) {
          auto.push({
            kind: 'auto',
            id: i.interaction_id,
            sort_at: i.occurred_at,
            date: i.occurred_at,
            touch: i.kind,
            text: i.text,
            party_id: px.party_id,
            name: px.name,
            avatar_color: px.avatar_color,
          });
        });
      });
      var entries = owner.concat(auto).sort(function (a, b) {
        return String(b.sort_at).localeCompare(String(a.sort_at));
      });
      return { entries: entries };
    }
    if (query === 'search') {
      var term = String(input.term || '')
        .trim()
        .toLowerCase();
      if (!term) return { people: [] };
      var hits = peopleStore.people.filter(function (px) {
        var noteText = px.notes
          .map(function (n) {
            return n.text;
          })
          .join(' ');
        return (px.name + ' ' + px.role + ' ' + noteText).toLowerCase().indexOf(term) !== -1;
      });
      return {
        people: hits.map(function (px) {
          var noteHit = px.notes.find(function (n) {
            return n.text.toLowerCase().indexOf(term) !== -1;
          });
          var row = peopleRow(px);
          // The real search query never re-fetches dates — reminders stays [].
          row.reminders = [];
          row.snippet = noteHit ? '…⟦' + noteHit.text.slice(0, 80) + '⟧…' : '';
          return row;
        }),
      };
    }
    console.warn('[mock-centraid] people: unmapped query', query);
    return {};
  }

  function peopleWrite(action, input) {
    function findPerson(id) {
      return peopleStore.people.find(function (p) {
        return p.party_id === id;
      });
    }
    function findCircle(id) {
      return peopleStore.circles.find(function (c) {
        return c.circle_id === id;
      });
    }
    function ok(output) {
      return {
        status: 'executed',
        invocationId: uid('inv'),
        receiptId: uid('receipt'),
        output: output || {},
      };
    }
    function refuse(predicate) {
      return { status: 'failed', reason: predicate, predicate: predicate };
    }
    function parked() {
      return { status: 'parked', invocationId: uid('inv') };
    }
    // Park when the write targets a person whose NAME carries the marker, or
    // when the typed text itself does.
    function personParked(p) {
      return p && isParkTrigger(p.name);
    }

    switch (action) {
      case 'add-person': {
        var displayName = String(input.display_name || '').trim();
        if (isParkTrigger(displayName)) return parked();
        var id = uid('party');
        peopleStore.people.unshift({
          party_id: id,
          name: displayName,
          role: input.role || '',
          avatar_color: input.avatar_color || null,
          cadence_days: Number(input.cadence_days) || 30,
          last_contacted_at: null,
          created_at: new Date().toISOString(),
          met: '',
          circle_id: input.circle_id || null,
          starred: false,
          contact: [],
          relationships: [],
          dates: [],
          notes: [],
          tasks: [],
          gifts: [],
          debts: [],
          interactions: [],
        });
        return ok({ party_id: id });
      }
      case 'edit-person': {
        var p1 = findPerson(input.party_id);
        if (!p1) return refuse('not_found');
        if (personParked(p1) || isParkTrigger(input.display_name)) return parked();
        if (input.display_name != null) p1.name = String(input.display_name);
        if (input.role != null) p1.role = String(input.role);
        if (input.avatar_color != null) p1.avatar_color = String(input.avatar_color);
        if (input.met != null) p1.met = String(input.met);
        return ok({ party_id: p1.party_id });
      }
      case 'set-cadence': {
        var p2 = findPerson(input.party_id);
        if (!p2) return refuse('not_found');
        if (personParked(p2)) return parked();
        p2.cadence_days = Number(input.cadence_days);
        return ok({ party_id: p2.party_id });
      }
      case 'log-interaction': {
        var p3 = findPerson(input.party_id);
        if (!p3) return refuse('not_found');
        if (personParked(p3) || isParkTrigger(input.text)) return parked();
        var now = new Date().toISOString();
        p3.interactions.unshift({
          interaction_id: uid('int'),
          kind: String(input.kind),
          text: input.text ? String(input.text) : '',
          occurred_at: now,
        });
        p3.last_contacted_at = now;
        return ok({ interaction_id: p3.interactions[0].interaction_id });
      }
      case 'star-person':
      case 'unstar-person': {
        var p4 = findPerson(input.party_id);
        if (!p4) return refuse('not_found');
        if (personParked(p4)) return parked();
        p4.starred = action === 'star-person';
        return ok({ party_id: p4.party_id });
      }
      case 'move-person': {
        var p5 = findPerson(input.party_id);
        if (!p5) return refuse('not_found');
        if (personParked(p5)) return parked();
        if (input.circle_id != null && !findCircle(input.circle_id)) return refuse('not_found');
        p5.circle_id = input.circle_id != null ? String(input.circle_id) : null;
        return ok({ party_id: p5.party_id });
      }
      case 'add-note': {
        var p6 = findPerson(input.party_id);
        if (!p6) return refuse('not_found');
        if (personParked(p6) || isParkTrigger(input.text)) return parked();
        var note = {
          annotation_id: uid('note'),
          text: String(input.text),
          created_at: new Date().toISOString(),
        };
        p6.notes.unshift(note);
        return ok({ annotation_id: note.annotation_id });
      }
      case 'add-task': {
        var p7 = findPerson(input.party_id);
        if (!p7) return refuse('not_found');
        if (personParked(p7) || isParkTrigger(input.text)) return parked();
        var ptask = { task_id: uid('ptask'), text: String(input.text), done: false };
        p7.tasks.unshift(ptask);
        return ok({ task_id: ptask.task_id });
      }
      case 'toggle-task': {
        var ownerT = null;
        var hitT = null;
        peopleStore.people.forEach(function (px) {
          px.tasks.forEach(function (t) {
            if (t.task_id === input.task_id) {
              ownerT = px;
              hitT = t;
            }
          });
        });
        if (!hitT) return refuse('not_found');
        if (personParked(ownerT)) return parked();
        hitT.done = !hitT.done;
        return ok({ task_id: hitT.task_id });
      }
      case 'add-important-date': {
        var p8 = findPerson(input.party_id);
        if (!p8) return refuse('not_found');
        if (personParked(p8) || isParkTrigger(input.label)) return parked();
        var date = {
          date_id: uid('date'),
          label: String(input.label),
          month_day: String(input.month_day),
          reminder_on: !!input.reminder_on,
        };
        p8.dates.push(date);
        return ok({ date_id: date.date_id });
      }
      case 'toggle-reminder': {
        var ownerD = null;
        var hitD = null;
        peopleStore.people.forEach(function (px) {
          px.dates.forEach(function (d) {
            if (d.date_id === input.date_id) {
              ownerD = px;
              hitD = d;
            }
          });
        });
        if (!hitD) return refuse('not_found');
        if (personParked(ownerD)) return parked();
        hitD.reminder_on = !hitD.reminder_on;
        return ok({ date_id: hitD.date_id });
      }
      case 'add-relationship': {
        var p9 = findPerson(input.party_id);
        if (!p9) return refuse('not_found');
        if (personParked(p9) || isParkTrigger(input.name)) return parked();
        var rel = {
          relationship_id: uid('rel'),
          name: String(input.name),
          kind: String(input.kind),
          pet: input.pet != null ? String(input.pet) : null,
        };
        p9.relationships.push(rel);
        return ok({ relationship_id: rel.relationship_id });
      }
      case 'add-gift': {
        var p10 = findPerson(input.party_id);
        if (!p10) return refuse('not_found');
        if (personParked(p10) || isParkTrigger(input.text)) return parked();
        var gift = { gift_id: uid('gift'), text: String(input.text), state: 'idea' };
        p10.gifts.unshift(gift);
        return ok({ gift_id: gift.gift_id });
      }
      case 'toggle-gift': {
        var ownerG = null;
        var hitG = null;
        peopleStore.people.forEach(function (px) {
          px.gifts.forEach(function (g) {
            if (g.gift_id === input.gift_id) {
              ownerG = px;
              hitG = g;
            }
          });
        });
        if (!hitG) return refuse('not_found');
        if (personParked(ownerG)) return parked();
        hitG.state = hitG.state === 'given' ? 'idea' : 'given';
        return ok({ gift_id: hitG.gift_id });
      }
      case 'add-debt': {
        var p11 = findPerson(input.party_id);
        if (!p11) return refuse('not_found');
        if (personParked(p11) || isParkTrigger(input.reason)) return parked();
        var debt = {
          debt_id: uid('debt'),
          direction: String(input.direction),
          amount_minor: Number(input.amount_minor),
          currency: 'USD',
          reason: input.reason ? String(input.reason) : '',
        };
        p11.debts.unshift(debt);
        return ok({ debt_id: debt.debt_id });
      }
      case 'settle-debt': {
        var ownerDb = null;
        peopleStore.people.forEach(function (px) {
          var idx = px.debts.findIndex(function (d) {
            return d.debt_id === input.debt_id;
          });
          if (idx !== -1) {
            ownerDb = px;
            if (!isParkTrigger(px.name)) px.debts.splice(idx, 1);
          }
        });
        if (!ownerDb) return refuse('not_found');
        if (personParked(ownerDb)) return parked();
        // The real command stamps settled_at; the person query filters those
        // out, so dropping the row is observationally identical.
        return ok({});
      }
      case 'create-circle': {
        var cname = String(input.name || '').trim();
        if (isParkTrigger(cname)) return parked();
        var dupC = peopleStore.circles.some(function (c) {
          return c.name === cname;
        });
        if (dupC) return refuse('name_unused_by_owner');
        var circle = { circle_id: uid('circle'), name: cname };
        peopleStore.circles.push(circle);
        return ok({ circle_id: circle.circle_id });
      }
      case 'rename-circle': {
        var c1 = findCircle(input.circle_id);
        if (!c1) return refuse('not_found');
        var newCName = String(input.name || '').trim();
        if (isParkTrigger(c1.name) || isParkTrigger(newCName)) return parked();
        var dupC2 = peopleStore.circles.some(function (c) {
          return c.circle_id !== c1.circle_id && c.name === newCName;
        });
        if (dupC2) return refuse('name_unused_by_owner');
        c1.name = newCName;
        return ok({ circle_id: c1.circle_id });
      }
      case 'delete-circle': {
        var c2 = findCircle(input.circle_id);
        if (!c2) return refuse('not_found');
        if (isParkTrigger(c2.name)) return parked();
        var occupied = peopleStore.people.some(function (px) {
          return px.circle_id === c2.circle_id;
        });
        if (occupied) return refuse('circle_is_empty');
        peopleStore.circles = peopleStore.circles.filter(function (c) {
          return c.circle_id !== c2.circle_id;
        });
        return ok({});
      }
      case 'add-journal-entry': {
        if (isParkTrigger(input.text)) return parked();
        var entry = {
          entry_id: uid('jr'),
          mood: String(input.mood),
          text: String(input.text),
          entry_date: input.entry_date ? String(input.entry_date) : dayKey(0),
          created_at: new Date().toISOString(),
        };
        peopleStore.journal.unshift(entry);
        return ok({ entry_id: entry.entry_id });
      }
      default:
        return null; // unmapped — caller logs + returns {}
    }
  }

  // ---------------------------------------------------------------------
  // Tally fixtures — see packages/blueprints/apps/tally/queries/dashboard.js
  // for the shared balance engine every query reads through: balances are
  // DERIVED (pairwise: positive = the friend owes me; groupNet: positive =
  // that member gets money back) and ledgerRow decorates each expense with
  // the owner's lent/borrowed stance + named splits. The store keeps ground
  // facts (friends/groups/expenses-with-splits/settlements) and this mock
  // ports those three fold functions verbatim. Money is INTEGER minor units;
  // currency INR keeps seed.js's Goa-trip amounts realistic (fmtMoney
  // localizes ₹). Scenario from apps/tally/seed.js (3 friends, Goa Trip,
  // 5 expenses, 1 partial settlement) plus a second group with exact- and
  // percent-style uneven splits. seed.js's icon 'Palmtree'/named colors are
  // NOT reused: the components render `icon` as a literal glyph and the
  // app's own pickers use emoji + hex (see format.js GROUP_ICONS /
  // FRIEND_COLORS), so the fixture follows the components. "(park)" in an
  // expense description / friend / group name parks the write.
  // ---------------------------------------------------------------------
  var TALLY_ME = 'party-you';

  function buildTallyStore() {
    if (EMPTY_MODE)
      return {
        me: TALLY_ME,
        currency: 'INR',
        friends: [],
        groups: [],
        expenses: [],
        settlements: [],
      };

    var friends = [
      { party_id: 'party-meera', name: 'Meera', avatar_color: '#E0567A' },
      { party_id: 'party-arjun', name: 'Arjun', avatar_color: '#2EA098' },
      { party_id: 'party-sana', name: 'Sana', avatar_color: '#7C5BD9' },
    ];
    var groups = [
      {
        group_id: 'group-goa',
        name: 'Goa Trip',
        icon: '🏖️',
        color: '#0FA678',
        members: [TALLY_ME, 'party-meera', 'party-arjun', 'party-sana'],
      },
      {
        group_id: 'group-flat',
        name: 'Flat 4B',
        icon: '🏠',
        color: '#4E68DD',
        members: [TALLY_ME, 'party-arjun'],
      },
    ];

    function exp(id, groupId, description, amount, paidBy, category, daysAgo, splits) {
      return {
        expense_id: id,
        group_id: groupId,
        description: description,
        amount_minor: amount,
        category: category,
        spent_on: dayKey(-daysAgo),
        paid_by: paidBy,
        splits: splits, // { party_id: share_minor } — must sum to amount_minor
      };
    }

    var expenses = [
      // Equal 4-way splits (remainder on the payer, like seed.js's even()).
      exp('exp-lunch', 'group-goa', 'Beach shack lunch', 248000, TALLY_ME, 'food', 6, {
        'party-you': 62000,
        'party-meera': 62000,
        'party-arjun': 62000,
        'party-sana': 62000,
      }),
      exp(
        'exp-scooter',
        'group-goa',
        'Scooter rentals, 2 days',
        160000,
        'party-arjun',
        'transport',
        6,
        {
          'party-you': 40000,
          'party-meera': 40000,
          'party-arjun': 40000,
          'party-sana': 40000,
        },
      ),
      exp(
        'exp-groceries',
        'group-goa',
        'Groceries for the villa',
        187550,
        'party-meera',
        'groceries',
        5,
        {
          'party-you': 46887,
          'party-meera': 46889,
          'party-arjun': 46887,
          'party-sana': 46887,
        },
      ),
      // Partial participation — Arjun sat this one out.
      exp('exp-market', 'group-goa', 'Night market', 92000, 'party-sana', 'fun', 4, {
        'party-you': 30666,
        'party-meera': 30666,
        'party-sana': 30668,
      }),
      exp('exp-ferry', 'group-goa', 'Ferry tickets', 60000, TALLY_ME, 'travel', 4, {
        'party-you': 15000,
        'party-meera': 15000,
        'party-arjun': 15000,
        'party-sana': 15000,
      }),
      // Exact-style uneven split (bigger room, bigger share).
      exp('exp-rent', 'group-flat', 'July rent', 3600000, TALLY_ME, 'rent', 10, {
        'party-you': 2000000,
        'party-arjun': 1600000,
      }),
      // Percent-style split (60/40).
      exp('exp-internet', 'group-flat', 'Fiber internet', 140000, 'party-arjun', 'utilities', 8, {
        'party-you': 84000,
        'party-arjun': 56000,
      }),
    ];

    var settlements = [
      {
        settlement_id: 'settle-1',
        from_party: 'party-sana',
        to_party: TALLY_ME,
        amount_minor: 50000,
        group_id: 'group-goa',
        paid_on: dayKey(-2),
      },
    ];

    return {
      me: TALLY_ME,
      currency: 'INR',
      friends: friends,
      groups: groups,
      expenses: expenses,
      settlements: settlements,
    };
  }

  var tallyStore = appId === 'tally' ? buildTallyStore() : null;

  function tallyInitials(name) {
    if (!name) return '?';
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map(function (w) {
        return w[0];
      })
      .join('')
      .toUpperCase();
  }
  function tallyPerson(pid) {
    if (pid === tallyStore.me) {
      return { party_id: pid, name: 'You', color: '#0FA678', initials: 'You', is_me: true };
    }
    var f = tallyStore.friends.find(function (x) {
      return x.party_id === pid;
    });
    if (!f)
      return { party_id: pid, name: 'Someone', color: '#5C677D', initials: '?', is_me: false };
    return {
      party_id: pid,
      name: f.name,
      color: f.avatar_color || '#5C677D',
      initials: tallyInitials(f.name),
      is_me: false,
    };
  }
  /** Port of queries/dashboard.js pairwise(): net per friend vs the owner —
   *  positive = they owe me. */
  function tallyPairwise() {
    var me = tallyStore.me;
    var b = {};
    tallyStore.friends.forEach(function (f) {
      b[f.party_id] = 0;
    });
    tallyStore.expenses.forEach(function (e) {
      Object.keys(e.splits).forEach(function (pid) {
        if (pid === e.paid_by) return;
        var share = e.splits[pid];
        if (e.paid_by === me && pid !== me) b[pid] = (b[pid] || 0) + share;
        else if (pid === me && e.paid_by !== me) b[e.paid_by] = (b[e.paid_by] || 0) - share;
      });
    });
    tallyStore.settlements.forEach(function (s) {
      if (s.from_party === me && s.to_party !== me)
        b[s.to_party] = (b[s.to_party] || 0) + s.amount_minor;
      else if (s.to_party === me && s.from_party !== me)
        b[s.from_party] = (b[s.from_party] || 0) - s.amount_minor;
    });
    return b;
  }
  /** Port of queries/dashboard.js groupNet(): net per member within a group —
   *  positive = gets money back. */
  function tallyGroupNet(gid) {
    var net = {};
    var g = tallyStore.groups.find(function (x) {
      return x.group_id === gid;
    });
    (g ? g.members : []).forEach(function (pid) {
      net[pid] = 0;
    });
    tallyStore.expenses.forEach(function (e) {
      if (e.group_id !== gid) return;
      net[e.paid_by] = (net[e.paid_by] || 0) + e.amount_minor;
      Object.keys(e.splits).forEach(function (pid) {
        net[pid] = (net[pid] || 0) - e.splits[pid];
      });
    });
    tallyStore.settlements.forEach(function (s) {
      if (s.group_id !== gid) return;
      net[s.from_party] = (net[s.from_party] || 0) + s.amount_minor;
      net[s.to_party] = (net[s.to_party] || 0) - s.amount_minor;
    });
    return net;
  }
  /** Port of queries/dashboard.js ledgerRow(): the expense decorated with the
   *  owner's lent/borrowed stance. */
  function tallyLedgerRow(e) {
    var me = tallyStore.me;
    var yourShare = e.splits[me] != null ? e.splits[me] : 0;
    var involved = e.splits[me] != null;
    var role;
    var amount;
    if (e.paid_by === me) {
      role = 'lent';
      amount = e.amount_minor - yourShare;
    } else if (involved) {
      role = 'borrowed';
      amount = yourShare;
    } else {
      role = 'none';
      amount = e.amount_minor;
    }
    return {
      expense_id: e.expense_id,
      group_id: e.group_id,
      description: e.description,
      amount_minor: e.amount_minor,
      category: e.category,
      spent_on: e.spent_on,
      paid_by: e.paid_by,
      paid_by_name: tallyPerson(e.paid_by).name,
      your_role: role,
      your_amount_minor: amount,
      splits: Object.keys(e.splits).map(function (pid) {
        var p = tallyPerson(pid);
        return {
          party_id: pid,
          name: p.name,
          color: p.color,
          initials: p.initials,
          share_minor: e.splits[pid],
        };
      }),
    };
  }
  function tallyGroupName(gid) {
    var g = tallyStore.groups.find(function (x) {
      return x.group_id === gid;
    });
    return g ? g.name : '';
  }
  function tallySortedExpenses() {
    return tallyStore.expenses.slice().sort(function (a, b) {
      return String(b.spent_on).localeCompare(String(a.spent_on));
    });
  }

  function tallyRead(query, input) {
    if (query === 'dashboard') {
      var bal = tallyPairwise();
      var friends = tallyStore.friends.map(function (f) {
        var p = tallyPerson(f.party_id);
        return {
          party_id: f.party_id,
          name: p.name,
          color: p.color,
          initials: p.initials,
          net_minor: bal[f.party_id] || 0,
        };
      });
      var owe = 0;
      var owed = 0;
      Object.keys(bal).forEach(function (pid) {
        if (bal[pid] > 0) owed += bal[pid];
        else if (bal[pid] < 0) owe += -bal[pid];
      });
      var groups = tallyStore.groups.map(function (g) {
        var net = tallyGroupNet(g.group_id);
        return {
          group_id: g.group_id,
          name: g.name,
          icon: g.icon,
          color: g.color,
          member_count: g.members.length,
          owner_net_minor: net[tallyStore.me] || 0,
        };
      });
      return {
        me: tallyStore.me,
        currency: tallyStore.currency,
        friends: friends,
        groups: groups,
        owe_total_minor: owe,
        owed_total_minor: owed,
      };
    }
    if (query === 'group') {
      var gid = String(input.group_id || '');
      var g = tallyStore.groups.find(function (x) {
        return x.group_id === gid;
      });
      if (!g)
        return {
          me: tallyStore.me,
          currency: tallyStore.currency,
          group: null,
          members: [],
          ledger: [],
        };
      var net = tallyGroupNet(gid);
      return {
        me: tallyStore.me,
        currency: tallyStore.currency,
        group: { group_id: g.group_id, name: g.name, icon: g.icon, color: g.color },
        members: g.members.map(function (pid) {
          var p = tallyPerson(pid);
          return {
            party_id: pid,
            name: p.name,
            color: p.color,
            initials: p.initials,
            is_me: p.is_me,
            net_minor: net[pid] || 0,
          };
        }),
        ledger: tallySortedExpenses()
          .filter(function (e) {
            return e.group_id === gid;
          })
          .map(tallyLedgerRow),
      };
    }
    if (query === 'friend') {
      var pid = String(input.party_id || '');
      var isFriend = tallyStore.friends.some(function (f) {
        return f.party_id === pid;
      });
      if (!isFriend || pid === tallyStore.me) {
        return { me: tallyStore.me, currency: tallyStore.currency, friend: null, ledger: [] };
      }
      var p = tallyPerson(pid);
      var netF = tallyPairwise()[pid] || 0;
      var me = tallyStore.me;
      return {
        me: me,
        currency: tallyStore.currency,
        friend: {
          party_id: pid,
          name: p.name,
          color: p.color,
          initials: p.initials,
          net_minor: netF,
        },
        ledger: tallySortedExpenses()
          .filter(function (e) {
            return (
              e.splits[pid] != null &&
              e.splits[me] != null &&
              (e.paid_by === pid || e.paid_by === me)
            );
          })
          .map(tallyLedgerRow),
      };
    }
    if (query === 'activity') {
      var meA = tallyStore.me;
      var rows = [];
      tallyStore.expenses.forEach(function (e) {
        var yourShare = e.splits[meA] != null ? e.splits[meA] : 0;
        var role = 'none';
        var amount = 0;
        if (e.paid_by === meA) {
          role = 'lent';
          amount = e.amount_minor - yourShare;
        } else if (e.splits[meA] != null) {
          role = 'borrowed';
          amount = yourShare;
        }
        rows.push({
          kind: 'expense',
          date: e.spent_on,
          description: e.description,
          category: e.category,
          group_name: tallyGroupName(e.group_id),
          paid_by: e.paid_by,
          paid_by_name: tallyPerson(e.paid_by).name,
          amount_minor: e.amount_minor,
          your_role: role,
          your_amount_minor: amount,
        });
      });
      tallyStore.settlements.forEach(function (s) {
        rows.push({
          kind: 'settlement',
          date: s.paid_on,
          from_party: s.from_party,
          from_name: tallyPerson(s.from_party).name,
          to_party: s.to_party,
          to_name: tallyPerson(s.to_party).name,
          amount_minor: s.amount_minor,
        });
      });
      rows.sort(function (a, b) {
        return String(b.date).localeCompare(String(a.date));
      });
      return { me: meA, currency: tallyStore.currency, activity: rows };
    }
    if (query === 'search') {
      var term = String(input.term || '')
        .trim()
        .toLowerCase();
      if (!term) return { me: null, currency: 'USD', results: [] };
      var results = tallySortedExpenses()
        .filter(function (e) {
          return (
            String(e.description || '')
              .toLowerCase()
              .indexOf(term) !== -1
          );
        })
        .map(function (e) {
          return Object.assign(tallyLedgerRow(e), { group_name: tallyGroupName(e.group_id) });
        });
      return { me: tallyStore.me, currency: tallyStore.currency, results: results };
    }
    console.warn('[mock-centraid] tally: unmapped query', query);
    return {};
  }

  function tallyWrite(action, input) {
    function findGroup(id) {
      return tallyStore.groups.find(function (g) {
        return g.group_id === id;
      });
    }
    function findExpense(id) {
      return tallyStore.expenses.find(function (e) {
        return e.expense_id === id;
      });
    }
    function splitsToMap(arr) {
      var map = {};
      (arr || []).forEach(function (s) {
        map[s.party_id] = Number(s.share_minor);
      });
      return map;
    }
    function ok(output) {
      return {
        status: 'executed',
        invocationId: uid('inv'),
        receiptId: uid('receipt'),
        output: output || {},
      };
    }
    function refuse(predicate) {
      return { status: 'failed', reason: predicate, predicate: predicate };
    }
    function parked() {
      return { status: 'parked', invocationId: uid('inv') };
    }

    switch (action) {
      case 'add-expense': {
        var desc = String(input.description || '').trim();
        if (isParkTrigger(desc)) return parked();
        var g0 = findGroup(input.group_id);
        if (!g0) return refuse('not_found');
        var e0 = {
          expense_id: uid('exp'),
          group_id: g0.group_id,
          description: desc,
          amount_minor: Number(input.amount_minor),
          category: input.category || 'general',
          spent_on: input.spent_on ? String(input.spent_on) : dayKey(0),
          paid_by: String(input.paid_by),
          splits: splitsToMap(input.splits),
        };
        tallyStore.expenses.unshift(e0);
        return ok({ expense_id: e0.expense_id });
      }
      case 'edit-expense': {
        var e1 = findExpense(input.expense_id);
        if (!e1) return refuse('not_found');
        if (isParkTrigger(e1.description) || isParkTrigger(input.description)) return parked();
        if (input.description != null) e1.description = String(input.description).trim();
        if (input.amount_minor != null) e1.amount_minor = Number(input.amount_minor);
        if (input.paid_by != null) e1.paid_by = String(input.paid_by);
        if (input.category != null) e1.category = String(input.category);
        if (input.spent_on != null) e1.spent_on = String(input.spent_on);
        if (input.splits != null) e1.splits = splitsToMap(input.splits);
        return ok({ expense_id: e1.expense_id });
      }
      case 'delete-expense': {
        var e2 = findExpense(input.expense_id);
        if (!e2) return refuse('not_found');
        if (isParkTrigger(e2.description)) return parked();
        tallyStore.expenses = tallyStore.expenses.filter(function (e) {
          return e.expense_id !== e2.expense_id;
        });
        return ok({});
      }
      case 'settle-up': {
        var s0 = {
          settlement_id: uid('settle'),
          from_party: String(input.from_party),
          to_party: String(input.to_party),
          amount_minor: Number(input.amount_minor),
          group_id: input.group_id != null ? String(input.group_id) : null,
          paid_on: input.paid_on ? String(input.paid_on) : dayKey(0),
        };
        tallyStore.settlements.unshift(s0);
        return ok({ settlement_id: s0.settlement_id });
      }
      case 'add-friend': {
        var fname = String(input.name || '').trim();
        if (isParkTrigger(fname)) return parked();
        var fid = uid('party');
        tallyStore.friends.push({
          party_id: fid,
          name: fname,
          avatar_color: input.avatar_color || '#5C677D',
        });
        return ok({ party_id: fid });
      }
      case 'create-group': {
        var gname = String(input.name || '').trim();
        if (isParkTrigger(gname)) return parked();
        var gid2 = uid('group');
        var memberIds = (input.member_ids || []).map(String);
        if (memberIds.indexOf(tallyStore.me) === -1) memberIds.unshift(tallyStore.me);
        tallyStore.groups.push({
          group_id: gid2,
          name: gname,
          icon: input.icon || '👥',
          color: input.color || '#0FA678',
          members: memberIds,
        });
        return ok({ group_id: gid2 });
      }
      case 'rename-group': {
        var g1 = findGroup(input.group_id);
        if (!g1) return refuse('not_found');
        var newGName = String(input.name || '').trim();
        if (isParkTrigger(g1.name) || isParkTrigger(newGName)) return parked();
        g1.name = newGName;
        return ok({ group_id: g1.group_id });
      }
      case 'add-group-member': {
        var g2 = findGroup(input.group_id);
        if (!g2) return refuse('not_found');
        if (isParkTrigger(g2.name)) return parked();
        var pidAdd = String(input.party_id);
        if (g2.members.indexOf(pidAdd) !== -1) return refuse('member_not_in_group');
        g2.members.push(pidAdd);
        return ok({});
      }
      case 'remove-group-member': {
        var g3 = findGroup(input.group_id);
        if (!g3) return refuse('not_found');
        if (isParkTrigger(g3.name)) return parked();
        var pidRm = String(input.party_id);
        var onLedger = tallyStore.expenses.some(function (e) {
          return e.group_id === g3.group_id && (e.paid_by === pidRm || e.splits[pidRm] != null);
        });
        if (onLedger) return refuse('member_off_ledger');
        g3.members = g3.members.filter(function (m) {
          return m !== pidRm;
        });
        return ok({});
      }
      case 'delete-group': {
        var g4 = findGroup(input.group_id);
        if (!g4) return refuse('not_found');
        if (isParkTrigger(g4.name)) return parked();
        var holdsExpenses = tallyStore.expenses.some(function (e) {
          return e.group_id === g4.group_id;
        });
        if (holdsExpenses) return refuse('group_holds_no_expenses');
        tallyStore.groups = tallyStore.groups.filter(function (g) {
          return g.group_id !== g4.group_id;
        });
        return ok({});
      }
      default:
        return null; // unmapped — caller logs + returns {}
    }
  }

  // ---------------------------------------------------------------------
  // Locker fixtures — see packages/blueprints/apps/locker/queries/items.js
  // for the secret-free list-row shape (item_id/type/title/subtitle/favorite/
  // tags/weak/reused/compromised/severity/updated_at/purge_at) and item.js
  // for the single-item detail — the ONLY query carrying secrets (password/
  // otp_seed/card_number/cvv/content, plaintext here since there is no
  // reveal round trip to mock). The store keeps one superset object per
  // item; lockerRow() replicates items.js's subtitleOf()/severity rules. The
  // GitHub login carries the classic 'JBSWY3DPEHPK3PXP' base32 seed so the
  // real totp.js ticker computes live 6-digit codes. Trash rows lose their
  // weak/reused flags (queries/trash.js never consults the watchtower) —
  // replicated on purpose. locker has no seed.js; data is invented. The
  // UI's "Connector alias" field sends an `alias` key the real action
  // wrappers silently drop — the mock ignores it the same way. "(park)" in
  // an item title parks every write against it.
  // ---------------------------------------------------------------------
  function buildLockerStore() {
    if (EMPTY_MODE) return { items: [] };

    function item(id, type, title, opts) {
      opts = opts || {};
      return {
        item_id: id,
        type: type,
        title: title,
        username: opts.username || null,
        password: opts.password || null,
        url: opts.url || null,
        otp_seed: opts.otp_seed || null,
        notes: opts.notes || null,
        cardholder: opts.cardholder || null,
        card_number: opts.card_number || null,
        expiry: opts.expiry || null,
        cvv: opts.cvv || null,
        brand: opts.brand || null,
        content: opts.content || null,
        fullname: opts.fullname || null,
        email: opts.email || null,
        phone: opts.phone || null,
        address: opts.address || null,
        network: opts.network || null,
        compromised: !!opts.compromised,
        weak: !!opts.weak,
        reused: !!opts.reused,
        favorite: !!opts.favorite,
        tags: opts.tags || [],
        trashed: !!opts.trashed,
        purge_at: opts.purge_at || null,
        updated_at: isoDaysAgo(opts.age != null ? opts.age : 10),
      };
    }

    var items = [
      item('item-github', 'login', 'GitHub', {
        username: 'maya-codes',
        password: 'correct-horse-battery-9!',
        url: 'https://github.com/login',
        otp_seed: 'JBSWY3DPEHPK3PXP',
        favorite: true,
        tags: ['dev', 'work'],
        age: 2,
      }),
      item('item-card-visa', 'card', 'HDFC Visa', {
        cardholder: 'Maya Krishnan',
        card_number: '4111111111111111',
        expiry: '09/28',
        cvv: '842',
        brand: 'Visa',
        tags: ['finance'],
        age: 11,
      }),
      item('item-note-server', 'note', 'Server room passcode', {
        content:
          'Rack B, cabinet 3. Combo 4-8-15-16.\nAsk facilities for the new badge before Friday.',
        tags: ['office'],
        age: 60,
      }),
      item('item-identity', 'identity', 'Personal', {
        fullname: 'Maya Krishnan',
        email: 'maya@fastmail.in',
        phone: '+91 98765 43210',
        address: '14 Cunningham Rd, Bengaluru 560052',
        age: 90,
      }),
      // Watchtower material: one weak+reused, one breached.
      item('item-forum', 'login', 'Old Forum Account', {
        username: 'maya',
        password: 'password1',
        url: 'https://forum.example.com',
        weak: true,
        reused: true,
        age: 200,
      }),
      item('item-linkedin', 'login', 'LinkedIn', {
        username: 'maya@fastmail.in',
        password: 'Sunshine123!',
        url: 'https://www.linkedin.com',
        compromised: true,
        tags: ['social'],
        age: 150,
      }),
      item('item-wifi-home', 'wifi', 'Home Wi-Fi', {
        network: 'Casa-5G',
        password: 'chai-biscuit-42',
        age: 30,
      }),
      item('item-door-code', 'password', 'Building door code', {
        password: '4415#',
        tags: ['home'],
        age: 45,
      }),
      // Parks every write against it (title marker).
      item('item-bank', 'login', 'Netbanking (park)', {
        username: 'maya.krishnan',
        password: 'v3ry-s3cret-phrase',
        url: 'https://netbanking.example.in',
        tags: ['finance'],
        age: 5,
      }),
      // Trashed — only the `trash` query returns it.
      item('item-myspace', 'login', 'MySpace', {
        username: 'maya_2006',
        password: 'letmein',
        url: 'https://myspace.com',
        trashed: true,
        purge_at: isoDaysFromNow(18),
        age: 25,
      }),
    ];

    return { items: items };
  }

  var lockerStore = appId === 'locker' ? buildLockerStore() : null;

  /** Replicates queries/items.js decorate(): the secret-free list row.
   *  Trash rows (queries/trash.js) never consult the watchtower, so their
   *  weak/reused read false and severity comes from `compromised` alone. */
  function lockerRow(it, inTrash) {
    var subtitle;
    if (it.type === 'login') subtitle = it.username || '—';
    else if (it.type === 'card')
      subtitle = it.card_number ? '•••• ' + it.card_number.slice(-4) : 'Card';
    else if (it.type === 'note') subtitle = 'Secure note';
    else if (it.type === 'identity') subtitle = it.email || '—';
    else if (it.type === 'wifi') subtitle = it.network || '—';
    else subtitle = 'Password';
    var weak = inTrash ? false : it.weak;
    var reused = inTrash ? false : it.reused;
    var severity = it.compromised ? 'danger' : weak || reused ? 'warn' : '';
    return {
      item_id: it.item_id,
      type: it.type,
      title: it.title,
      subtitle: subtitle,
      favorite: it.favorite,
      tags: it.tags.slice().sort(),
      weak: weak,
      reused: reused,
      compromised: it.compromised,
      severity: severity,
      updated_at: it.updated_at,
      purge_at: it.purge_at,
    };
  }

  function lockerRead(query, input) {
    function live() {
      return lockerStore.items.filter(function (it) {
        return !it.trashed;
      });
    }
    if (query === 'items') {
      var limit = Math.min(Math.max(Number(input.limit) || 300, 20), 2000);
      var rows = live().map(function (it) {
        return lockerRow(it, false);
      });
      return { items: rows.slice(0, limit), truncated: rows.length > limit, window: limit };
    }
    if (query === 'item') {
      var it = lockerStore.items.find(function (x) {
        return x.item_id === String(input.item_id || '');
      });
      if (!it) return { item: null };
      return {
        item: {
          item_id: it.item_id,
          type: it.type,
          title: it.title,
          username: it.username,
          password: it.password,
          url: it.url,
          otp_seed: it.otp_seed,
          notes: it.notes,
          cardholder: it.cardholder,
          card_number: it.card_number,
          expiry: it.expiry,
          cvv: it.cvv,
          brand: it.brand,
          content: it.content,
          fullname: it.fullname,
          email: it.email,
          phone: it.phone,
          address: it.address,
          network: it.network,
          compromised: it.compromised,
          favorite: it.favorite,
          tags: it.tags.slice().sort(),
          trashed: it.trashed,
          purge_at: it.purge_at,
          updated_at: it.updated_at,
        },
      };
    }
    if (query === 'search') {
      var term = String(input.term || '')
        .trim()
        .toLowerCase();
      if (!term) return { items: [] };
      return {
        items: live()
          .filter(function (x) {
            var hay = (x.title + ' ' + (x.username || '') + ' ' + (x.url || '')).toLowerCase();
            return hay.indexOf(term) !== -1;
          })
          .map(function (x) {
            return lockerRow(x, false);
          }),
      };
    }
    if (query === 'watchtower') {
      var affected = live().filter(function (x) {
        return x.compromised || x.weak || x.reused;
      });
      return {
        compromised: live().filter(function (x) {
          return x.compromised;
        }).length,
        weak: live().filter(function (x) {
          return x.weak;
        }).length,
        reused: live().filter(function (x) {
          return x.reused;
        }).length,
        items: affected.map(function (x) {
          return lockerRow(x, false);
        }),
      };
    }
    if (query === 'trash') {
      return {
        items: lockerStore.items
          .filter(function (x) {
            return x.trashed;
          })
          .map(function (x) {
            return lockerRow(x, true);
          }),
      };
    }
    console.warn('[mock-centraid] locker: unmapped query', query);
    return {};
  }

  // Field lists straight from app.json's add-item/edit-item input schemas —
  // anything else (the UI's `alias`, notably) is silently dropped, exactly
  // like the real action wrappers' FIELDS whitelist.
  var LOCKER_FIELDS = [
    'username',
    'password',
    'url',
    'otp_seed',
    'notes',
    'cardholder',
    'card_number',
    'expiry',
    'cvv',
    'brand',
    'content',
    'fullname',
    'email',
    'phone',
    'address',
    'network',
  ];

  function lockerWrite(action, input) {
    function findItem(id) {
      return lockerStore.items.find(function (x) {
        return x.item_id === id;
      });
    }
    function ok(output) {
      return {
        status: 'executed',
        invocationId: uid('inv'),
        receiptId: uid('receipt'),
        output: output || {},
      };
    }
    function refuse(predicate) {
      return { status: 'failed', reason: predicate, predicate: predicate };
    }
    function parked() {
      return { status: 'parked', invocationId: uid('inv') };
    }

    switch (action) {
      case 'add-item': {
        var title = String(input.title || '').trim();
        if (isParkTrigger(title)) return parked();
        var id = uid('item');
        var it0 = {
          item_id: id,
          type: String(input.type || 'login'),
          title: title,
          compromised: false,
          weak: false,
          reused: false,
          favorite: false,
          tags: (input.tags || []).map(String),
          trashed: false,
          purge_at: null,
          updated_at: new Date().toISOString(),
        };
        LOCKER_FIELDS.forEach(function (f) {
          it0[f] = input[f] != null ? String(input[f]) : null;
        });
        lockerStore.items.unshift(it0);
        return ok({ item_id: id });
      }
      case 'edit-item': {
        var it1 = findItem(input.item_id);
        if (!it1) return refuse('not_found');
        if (it1.trashed) return refuse('item_trashed');
        if (isParkTrigger(it1.title) || isParkTrigger(input.title)) return parked();
        if (input.title != null) it1.title = String(input.title);
        if (input.tags != null) it1.tags = input.tags.map(String);
        LOCKER_FIELDS.forEach(function (f) {
          if (input[f] != null) it1[f] = String(input[f]);
        });
        it1.updated_at = new Date().toISOString();
        return ok({ item_id: it1.item_id });
      }
      case 'trash-item': {
        var it2 = findItem(input.item_id);
        if (!it2) return refuse('not_found');
        if (isParkTrigger(it2.title)) return parked();
        it2.trashed = true;
        it2.purge_at = isoDaysFromNow(30);
        it2.updated_at = new Date().toISOString();
        return ok({ item_id: it2.item_id });
      }
      case 'restore-item': {
        var it3 = findItem(input.item_id);
        if (!it3) return refuse('not_found');
        if (isParkTrigger(it3.title)) return parked();
        it3.trashed = false;
        it3.purge_at = null;
        it3.updated_at = new Date().toISOString();
        return ok({ item_id: it3.item_id });
      }
      case 'purge-item': {
        var it4 = findItem(input.item_id);
        if (!it4) return refuse('not_found');
        if (isParkTrigger(it4.title)) return parked();
        lockerStore.items = lockerStore.items.filter(function (x) {
          return x.item_id !== it4.item_id;
        });
        return ok({});
      }
      case 'star-item': {
        var it5 = findItem(input.item_id);
        if (!it5) return refuse('not_found');
        if (it5.trashed) return refuse('item_trashed');
        if (isParkTrigger(it5.title)) return parked();
        it5.favorite = true;
        return ok({ item_id: it5.item_id });
      }
      case 'unstar-item': {
        var it6 = findItem(input.item_id);
        if (!it6) return refuse('not_found');
        if (isParkTrigger(it6.title)) return parked();
        it6.favorite = false;
        return ok({ item_id: it6.item_id });
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
      if (appId === 'people') return peopleRead(opts.query, opts.input || {});
      if (appId === 'tally') return tallyRead(opts.query, opts.input || {});
      if (appId === 'locker') return lockerRead(opts.query, opts.input || {});
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
      else if (appId === 'people') result = peopleWrite(opts.action, opts.input || {});
      else if (appId === 'tally') result = tallyWrite(opts.action, opts.input || {});
      else if (appId === 'locker') result = lockerWrite(opts.action, opts.input || {});
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
      // Empty `tables` = "this app's own write" — the shape the real runtime
      // emits for handler writes, and the one the kit's table filter always
      // lets through (a bare app id would match no declared table name).
      if (result.status !== 'parked') fireChange([]);
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
                : appId === 'people'
                  ? peopleStore
                  : appId === 'tally'
                    ? tallyStore
                    : appId === 'locker'
                      ? lockerStore
                      : null;
    },
    reset() {
      if (appId === 'docs') docsStore = buildDocsStore();
      else if (appId === 'photos') photosStore = buildPhotosStore();
      else if (appId === 'tasks') tasksStore = buildTasksStore();
      else if (appId === 'notes') notesStore = buildNotesStore();
      else if (appId === 'agenda') agendaStore = buildAgendaStore();
      else if (appId === 'people') peopleStore = buildPeopleStore();
      else if (appId === 'tally') tallyStore = buildTallyStore();
      else if (appId === 'locker') lockerStore = buildLockerStore();
      fireChange([appId]);
    },
    fireChange: fireChange,
  };

  console.info(
    '[mock-centraid] armed for app=' +
      appId +
      (EMPTY_MODE ? ' (empty)' : '') +
      (DENIED_MODE ? ' (denied)' : ''),
  );
})();
