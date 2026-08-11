import * as Sentry from '@sentry/nestjs';

export function initializeSentry() {
  const dsn = process.env.SENTRY_DSN;
  const environment = process.env.NODE_ENV || 'development';
  const enabled = process.env.SENTRY_ENABLED === 'true';

  if (!enabled || !dsn) {
    console.log('Sentry disabled - set SENTRY_DSN and SENTRY_ENABLED=true to enable');
    return;
  }

  Sentry.init({
    dsn,
    environment,
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
    profilesSampleRate: environment === 'production' ? 0.1 : 1.0,
    beforeSend(event, hint) {
      if (event.request) {
        if (event.request.headers) {
          delete event.request.headers['authorization'];
          delete event.request.headers['cookie'];
        }
        if (event.request.data) {
          const data = event.request.data as any;
          if (data.password) delete data.password;
          if (data.token) delete data.token;
          if (data.refreshToken) delete data.refreshToken;
        }
      }
      return event;
    },
  });

  console.log('Sentry initialized');
}

