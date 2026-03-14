import sharp from 'sharp';
import { logger } from './logger.js';

export interface ProcessedImage {
  base64: string;
  mediaType: string;
}

const MAX_DIMENSION = 1568;

export async function downloadAndProcessImage(
  url: string,
): Promise<ProcessedImage | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn({ url, status: response.status }, 'Image - download failed');
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const processed = await sharp(buffer)
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();

    logger.debug(
      { url, originalSize: buffer.length, processedSize: processed.length },
      'Image processed',
    );

    return {
      base64: processed.toString('base64'),
      mediaType: 'image/jpeg',
    };
  } catch (err) {
    logger.warn(
      { url, err: err instanceof Error ? err.message : String(err) },
      'Image - processing failed',
    );
    return null;
  }
}
