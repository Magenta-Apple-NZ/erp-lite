// Shared PrintNode helpers.
// Auth is HTTP Basic with the API key as the username and an empty password.

export function printNodeHeaders(apiKey) {
    const basic = btoa(apiKey + ':');
    return {
        'Authorization': 'Basic ' + basic,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
}

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export function errResponse(msg, status = 500) {
    return jsonResponse({ error: msg }, status);
}
