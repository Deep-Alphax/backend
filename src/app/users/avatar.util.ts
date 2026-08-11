import sharp from 'sharp';

/** Lado do avatar quadrado (px). */
export const AVATAR_SIZE = 128;
/** Content-type do avatar re-hospedado. */
export const AVATAR_MIME = 'image/webp';
/** Teto do download da imagem-fonte (anti-DoS ao baixar a foto do Google). */
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

export interface ProcessedAvatar {
  data: Buffer;
  mime: string;
}

/**
 * Normaliza uma imagem-fonte em um avatar pequeno e uniforme: aplica a orientação
 * EXIF, recorta para um quadrado AVATAR_SIZE (cover, centralizado) e recodifica em
 * webp. Entrada não-imagem/corrompida faz o sharp LANÇAR. Puro (CPU-only, sem I/O)
 * → testável de forma determinística.
 */
export async function processAvatar(source: Buffer): Promise<ProcessedAvatar> {
  const data = await sharp(source)
    .rotate() // respeita a orientação EXIF
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
    .webp({ quality: 80 })
    .toBuffer();
  return { data, mime: AVATAR_MIME };
}
