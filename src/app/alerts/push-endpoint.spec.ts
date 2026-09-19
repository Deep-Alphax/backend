import { isAllowedPushEndpoint } from './push-endpoint';

describe('isAllowedPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc:123',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://web.push.apple.com/QGx1',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
  ])('aceita provedor real: %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(true);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc', // sem TLS
    'https://fcm.googleapis.com:8443/fcm/send/abc', // porta fora do padrão
    'https://169.254.169.254/latest/meta-data', // metadata da nuvem
    'https://localhost/x',
    'https://fcm.googleapis.com.evil.com/x', // sufixo enganoso
    'https://evilnotify.windows.com/x', // sem o ponto do sufixo
    'https://user:pass@fcm.googleapis.com/x',
    'not a url',
    '',
    `https://fcm.googleapis.com/${'a'.repeat(2000)}`,
  ])('recusa: %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(false);
  });
});
