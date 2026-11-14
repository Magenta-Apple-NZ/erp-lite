// Google Drive service account (GDRIVE_SA_KEY, the service account's JSON
// key) — shared by the LC archive (lc-docs.js) and Settings → Integrations.

// The service account's email: Drive folders are shared with this address.
// → { configured, email, error }
export function serviceAccountInfo(env) {
    if (!env.GDRIVE_SA_KEY) return { configured: false, email: null, error: null };
    try {
        const sa = typeof env.GDRIVE_SA_KEY === 'string' ? JSON.parse(env.GDRIVE_SA_KEY) : env.GDRIVE_SA_KEY;
        return { configured: true, email: sa.client_email || null, error: sa.private_key ? null : 'GDRIVE_SA_KEY has no private_key' };
    } catch (e) {
        return { configured: true, email: null, error: 'GDRIVE_SA_KEY is set but not valid JSON' };
    }
}

// Build a Google service-account JWT and exchange it for an access token.
// Expects sa to be the parsed service account JSON (or JSON string).
export async function getGdriveToken(saJson) {
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
