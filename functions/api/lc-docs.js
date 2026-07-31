function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
function errResponse(msg, status = 500) {
    return jsonResponse({ error: msg }, status);
}

function extractFolderId(url) {
    const m = (url || '').match(/\/folders\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : (url || '').trim();
}

// Build a Google service-account JWT and exchange it for an access token.
// Expects sa to be the parsed service account JSON (or JSON string).
async function getGdriveToken(saJson) {
    const sa  = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
    const now = Math.floor(Date.now() / 1000);

    const toB64url = buf =>
        btoa(String.fromCharCode(...new Uint8Array(buf)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const header  = toB64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const payload = toB64url(new TextEncoder().encode(JSON.stringify({
        iss:   sa.client_email,
        scope: 'https://www.googleapis.com/auth/drive',
        aud:   'https://oauth2.googleapis.com/token',
        iat:   now,
        exp:   now + 3600,
    })));
    const unsigned = `${header}.${payload}`;

    const pem    = sa.private_key.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
    const keyDer = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
        'pkcs8', keyDer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['sign']
    );
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
    const jwt = `${unsigned}.${toB64url(sig)}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const tok = await res.json();
    if (!tok.access_token) {
        throw new Error('Drive auth failed: ' + (tok.error_description || tok.error || JSON.stringify(tok)));
    }
    return tok.access_token;
}

// Multipart upload to Google Drive.
async function uploadToGdrive(token, folderId, filename, base64Data) {
    const meta     = JSON.stringify({ name: filename, parents: [folderId] });
    const boundary = '----HubBound' + Date.now();
    const enc      = new TextEncoder();

    const fileBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    const part1 = enc.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`
    );
    const part2 = enc.encode(`\r\n--${boundary}--`);

    const body = new Uint8Array(part1.length + fileBytes.length + part2.length);
    body.set(part1, 0);
    body.set(fileBytes, part1.length);
    body.set(part2, part1.length + fileBytes.length);

    const res = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink',
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type':  `multipart/related; boundary=${boundary}`,
            },
            body,
        }
    );
    if (!res.ok) {
        const raw = await res.text();
        let reason = '', message = '';
        try {
            const j = JSON.parse(raw);
            reason  = j.error?.errors?.[0]?.reason || '';
            message = j.error?.message || '';
        } catch (_) { message = raw.slice(0, 200); }
        // Service accounts have no Drive storage of their own, so they can't own
        // files uploaded into an ordinary My Drive folder — Google returns 403
        // storageQuotaExceeded. The fix is a Shared Drive (files owned by the
        // drive, not the account).
        if (res.status === 403 && /storageQuota|quota/i.test(reason + message)) {
            throw new Error('Drive 403 storageQuotaExceeded — a service account can’t store files in a personal My Drive folder. Move the LC folder into a Shared Drive and share that with the service account.');
        }
        if (res.status === 403 && /permission/i.test(reason + message)) {
            throw new Error('Drive 403 insufficientPermissions — share the folder with the service account as Editor (Content Manager on a Shared Drive).');
        }
        throw new Error(`Drive upload ${res.status}${reason ? ' ' + reason : ''}: ${message}`.slice(0, 300));
    }
    return await res.json(); // { id, name, webViewLink }
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOCS_FOLDER = '2. LC Documentation';
const ARCH_FOLDER = 'z. Archived';

// Find a child folder by name under parentId, creating it if absent. Returns folder id.
async function findOrCreateFolder(token, parentId, name) {
    const q = encodeURIComponent(
        `name = '${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`
    );
    const listRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!listRes.ok) throw new Error(`Drive folder lookup ${listRes.status}: ${(await listRes.text()).slice(0, 200)}`);
    const list = await listRes.json();
    if (list.files?.length) return list.files[0].id;

    const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    if (!createRes.ok) {
        const raw = await createRes.text();
        if (createRes.status === 404) {
            const isSharedDriveRoot = /^0A/.test(parentId);
            throw new Error(
                `Drive 404 — the linked folder (${parentId}) isn't visible to the service account. `
                + (isSharedDriveRoot
                    ? 'That ID is a Shared Drive root; link a folder INSIDE the Shared Drive (id starts with "1") and ensure the service account is a member.'
                    : 'Check the folder URL is correct and shared with the service account.'));
        }
        throw new Error(`Drive folder create ${createRes.status}: ${raw.slice(0, 200)}`);
    }
    return (await createRes.json()).id;
}

// Move a Drive file to a new parent folder (removing its current parents).
async function moveDriveFile(token, fileId, toParentId) {
    const getRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!getRes.ok) throw new Error(`Drive get parents ${getRes.status}`);
    const parents = ((await getRes.json()).parents || []).join(',');
    const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${toParentId}${parents ? '&removeParents=' + parents : ''}&fields=id&supportsAllDrives=true`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }
    );
    if (!res.ok) throw new Error(`Drive move ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// GET /api/lc-docs?lcId=xxx     — list archived docs
// GET /api/lc-docs?status=1     — Drive integration health (is the key set,
//                                 and which service-account email to share the
//                                 target folder with)
export async function onRequestGet({ env, request }) {
    try {
        const url = new URL(request.url);

        if (url.searchParams.get('status') === '1') {
            let email = null, keyError = null;
            if (env.GDRIVE_SA_KEY) {
                try {
                    const sa = typeof env.GDRIVE_SA_KEY === 'string' ? JSON.parse(env.GDRIVE_SA_KEY) : env.GDRIVE_SA_KEY;
                    email = sa.client_email || null;
                } catch (e) { keyError = 'GDRIVE_SA_KEY is set but not valid JSON'; }
            }
            return jsonResponse({
                configured: !!env.GDRIVE_SA_KEY,
                serviceAccountEmail: email,   // share the Drive folder with this address (Editor)
                keyError,
                folderScheme: 'linkedFolder / <shipment name> / <file>',
                defaultFolder: DOCS_FOLDER,    // fallback when the LC has no shipment
                archiveFolder: ARCH_FOLDER,    // superseded files, inside the shipment folder
            });
        }

        const lcId = url.searchParams.get('lcId');
        if (!lcId) return errResponse('lcId required', 400);
        const raw  = await env.ORDERS_KV.get('lc-doc-meta:' + lcId);
        return jsonResponse({ docs: raw ? JSON.parse(raw) : [] });
    } catch (e) {
        return errResponse(e.message);
    }
}

// POST /api/lc-docs — archive PDF to KV and optionally upload to Drive
// body: { lcId, docType, docTitle, filename, data: base64, driveFolderUrl?,
//         subfolder?, draft?: bool }
// subfolder: Drive folder (inside the linked folder) to file into — the
// shipment name, e.g. "Shipment 42". Defaults to "2. LC Documentation".
export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const { lcId, docType, docTitle, filename, data, driveFolderUrl } = body;
        const subfolder = (body.subfolder && String(body.subfolder).trim()) || DOCS_FOLDER;
        const isDraft = body.draft === true;
        if (!lcId || !data) return errResponse('lcId and data required', 400);

        const key = `${lcId}-${docType}-${Date.now()}`;
        await env.ORDERS_KV.put('lc-doc:' + key, data);

        // Google Drive upload — non-blocking: failure is recorded but doesn't fail the request.
        // Layout inside the linked folder: "2. LC Documentation" holds current files;
        // superseded versions are moved to "2. LC Documentation/z. Archived".
        let driveFileId   = null;
        let driveViewLink = null;
        let driveError    = null;
        let driveToken    = null;
        let docsFolderId  = null;

        if (driveFolderUrl && env.GDRIVE_SA_KEY) {
            try {
                const rootId  = extractFolderId(driveFolderUrl);
                driveToken    = await getGdriveToken(env.GDRIVE_SA_KEY);
                docsFolderId  = await findOrCreateFolder(driveToken, rootId, subfolder);
                const file    = await uploadToGdrive(driveToken, docsFolderId, filename || 'document.pdf', data);
                driveFileId   = file.id;
                driveViewLink = file.webViewLink;
            } catch (e) {
                driveError = e.message;
                console.error(`[lc-docs POST] Drive upload failed — lcId=${lcId} docType=${docType} file=${filename}: ${e.message}`);
            }
        }

        const meta = {
            key,
            docType,
            docTitle:     docTitle || docType,
            filename:     filename || 'document.pdf',
            uploadedAt:   new Date().toISOString(),
            draft:        isDraft,
            driveFileId,
            driveViewLink,
            driveError,
        };

        const raw  = await env.ORDERS_KV.get('lc-doc-meta:' + lcId);
        const docs = raw ? JSON.parse(raw) : [];

        // When saving a Final, supersede any earlier Finals for the same docType.
        let superseded = 0;
        const supersededDriveIds = [];
        if (!isDraft) {
            docs.forEach(d => {
                if (d.docType === docType && !d.draft && !d.superseded) {
                    d.superseded = true;
                    superseded++;
                    if (d.driveFileId) supersededDriveIds.push(d.driveFileId);
                }
            });
        }

        // Move superseded files on Drive into z. Archived — non-fatal if it fails
        if (supersededDriveIds.length && driveToken && docsFolderId) {
            try {
                const archId = await findOrCreateFolder(driveToken, docsFolderId, ARCH_FOLDER);
                for (const fid of supersededDriveIds) {
                    await moveDriveFile(driveToken, fid, archId).catch(e =>
                        console.error(`[lc-docs POST] archive move failed — fileId=${fid}: ${e.message}`));
                }
            } catch (e) {
                console.error(`[lc-docs POST] z. Archived folder unavailable — lcId=${lcId}: ${e.message}`);
            }
        }

        docs.unshift(meta);
        await env.ORDERS_KV.put('lc-doc-meta:' + lcId, JSON.stringify(docs));

        return jsonResponse({ ok: true, key, meta, superseded }, 201);
    } catch (e) {
        return errResponse(e.message);
    }
}

// PUT /api/lc-docs — backfill: push archived docs not yet on Drive to the linked folder
// body: { lcId, driveFolderUrl, subfolder? }
export async function onRequestPut({ env, request }) {
    try {
        const body = await request.json();
        const { lcId, driveFolderUrl } = body;
        const subfolder = (body.subfolder && String(body.subfolder).trim()) || DOCS_FOLDER;
        if (!lcId) return errResponse('lcId required', 400);
        if (!driveFolderUrl) return errResponse('driveFolderUrl required', 400);
        if (!env.GDRIVE_SA_KEY) return errResponse('GDRIVE_SA_KEY not configured', 500);

        const raw  = await env.ORDERS_KV.get('lc-doc-meta:' + lcId);
        const docs = raw ? JSON.parse(raw) : [];

        // Current docs without a Drive copy get uploaded to the shipment folder;
        // superseded docs already on Drive get tidied into "z. Archived".
        const pending  = docs.filter(d => !d.driveFileId && !d.superseded);
        const toArchive = docs.filter(d => d.driveFileId && d.superseded);
        if (!pending.length && !toArchive.length) return jsonResponse({ ok: true, synced: 0, failed: 0 });

        const rootId       = extractFolderId(driveFolderUrl);
        const token        = await getGdriveToken(env.GDRIVE_SA_KEY);
        const docsFolderId = await findOrCreateFolder(token, rootId, subfolder);

        let synced = 0, failed = 0;
        for (const d of pending) {
            try {
                const data = await env.ORDERS_KV.get('lc-doc:' + d.key);
                if (!data) { d.driveError = 'File missing from KV'; failed++; continue; }
                const file = await uploadToGdrive(token, docsFolderId, d.filename || 'document.pdf', data);
                d.driveFileId   = file.id;
                d.driveViewLink = file.webViewLink;
                d.driveError    = null;
                synced++;
            } catch (e) {
                d.driveError = e.message;
                failed++;
                console.error(`[lc-docs PUT] sync upload failed — lcId=${lcId} file=${d.filename}: ${e.message}`);
            }
        }

        if (toArchive.length) {
            try {
                const archId = await findOrCreateFolder(token, docsFolderId, ARCH_FOLDER);
                for (const d of toArchive) {
                    await moveDriveFile(token, d.driveFileId, archId).catch(e =>
                        console.error(`[lc-docs PUT] archive move failed — file=${d.filename}: ${e.message}`));
                }
            } catch (e) {
                console.error(`[lc-docs PUT] z. Archived folder unavailable — lcId=${lcId}: ${e.message}`);
            }
        }

        await env.ORDERS_KV.put('lc-doc-meta:' + lcId, JSON.stringify(docs));
        return jsonResponse({ ok: true, synced, failed });
    } catch (e) {
        return errResponse(e.message);
    }
}

// DELETE /api/lc-docs?key=xxx&lcId=xxx
export async function onRequestDelete({ env, request }) {
    try {
        const url  = new URL(request.url);
        const key  = url.searchParams.get('key');
        const lcId = url.searchParams.get('lcId');
        if (!key || !lcId) return errResponse('key and lcId required', 400);

        await env.ORDERS_KV.delete('lc-doc:' + key);

        const raw = await env.ORDERS_KV.get('lc-doc-meta:' + lcId);
        if (raw) {
            const docs = JSON.parse(raw).filter(d => d.key !== key);
            await env.ORDERS_KV.put('lc-doc-meta:' + lcId, JSON.stringify(docs));
        }

        return jsonResponse({ ok: true });
    } catch (e) {
        return errResponse(e.message);
    }
}
