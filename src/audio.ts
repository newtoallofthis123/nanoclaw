import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const YAP_BIN = '/opt/homebrew/bin/yap';

export async function downloadAndTranscribeAudio(
  url: string,
): Promise<string | null> {
  const tmpFile = path.join(
    '/tmp',
    `nanoclaw-audio-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  try {
    if (!fs.existsSync(YAP_BIN)) {
      logger.warn('Audio - yap not found at %s', YAP_BIN);
      return null;
    }

    const response = await fetch(url);
    if (!response.ok) {
      logger.warn({ url, status: response.status }, 'Audio - download failed');
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tmpFile, buffer);

    const transcript = execFileSync(
      YAP_BIN,
      ['transcribe', '--locale', 'en_IN', tmpFile, '--txt'],
      {
        encoding: 'utf-8',
        timeout: 60_000,
      },
    ).trim();

    logger.debug({ url, length: transcript.length }, 'Audio transcribed');

    return transcript || null;
  } catch (err) {
    logger.warn(
      { url, err: err instanceof Error ? err.message : String(err) },
      'Audio - transcription failed',
    );
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}
