import sharp from 'sharp';
import { processAvatar, AVATAR_SIZE, AVATAR_MIME } from './avatar.util';

describe('processAvatar', () => {
  it('recorta para um quadrado AVATAR_SIZE e recodifica em webp', async () => {
    // Fonte sintética retangular (200×300) → `cover` deve produzir um quadrado.
    const source = await sharp({
      create: { width: 200, height: 300, channels: 3, background: { r: 10, g: 200, b: 50 } },
    })
      .png()
      .toBuffer();

    const { data, mime } = await processAvatar(source);

    expect(mime).toBe(AVATAR_MIME);
    const meta = await sharp(data).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(AVATAR_SIZE);
    expect(meta.height).toBe(AVATAR_SIZE);
  });

  it('produz saída não-vazia e menor/normalizada', async () => {
    const source = await sharp({
      create: { width: 512, height: 512, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();

    const { data } = await processAvatar(source);
    expect(data.length).toBeGreaterThan(0);
  });

  it('lança quando a entrada não é uma imagem válida', async () => {
    await expect(processAvatar(Buffer.from('isto não é uma imagem'))).rejects.toThrow();
  });
});
