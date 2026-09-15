// Copy to config.js and fill in your own Client ID.
//
// Spotify Developer Dashboard -> your app -> Settings. Under PKCE the Client ID is a public
// identifier, not a secret — but it is tied to YOUR dashboard app and its user allowlist, so
// each install registers its own rather than sharing one.
window.CONFIG = {
  clientId: 'PUT_YOUR_CLIENT_ID_HERE',
  deviceName: 'Living Room TV',      // what shows up in the Spotify Connect device picker
};
