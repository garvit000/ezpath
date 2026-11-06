/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AWS_REGION?: string;
  readonly VITE_LOCATION_MAP_NAME?: string;
  readonly VITE_LOCATION_API_KEY?: string;
  readonly VITE_LOCATION_SATELLITE_MAP_NAME?: string;
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
  readonly VITE_COGNITO_DOMAIN?: string;
  readonly VITE_APPSYNC_EVENTS_HTTP_URL?: string;
  readonly VITE_APPSYNC_EVENTS_REALTIME_URL?: string;
  readonly VITE_APPSYNC_EVENTS_API_KEY?: string;
  readonly VITE_APPSYNC_EVENTS_CHANNEL?: string;
  readonly VITE_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
