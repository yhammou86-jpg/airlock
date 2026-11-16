/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public URL of the WebSocket relay, e.g. https://airlock-relay.onrender.com */
  readonly VITE_RELAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
