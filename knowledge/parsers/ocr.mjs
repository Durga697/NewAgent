import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { ToolError } from '../../tools/errors.mjs';

const exec = promisify(execFile);

function validateImageMagic(buffer, extension) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    throw new ToolError('INVALID_DOCUMENT', 'Image file is empty or corrupted.');
  }
  if (extension === '.png') {
    const sig = buffer.subarray(0, 8);
    const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!sig.equals(expected)) {
      throw new ToolError('INVALID_DOCUMENT', 'Invalid PNG file signature.');
    }
    return;
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
      throw new ToolError('INVALID_DOCUMENT', 'Invalid JPEG file signature.');
    }
  }
}

function extractMockPngText(buffer) {
  const texts = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;
    if (type === 'tEXt') {
      const nul = buffer.indexOf(0x00, dataStart);
      if (nul !== -1 && nul < dataEnd) {
        const key = buffer.toString('latin1', dataStart, nul);
        if (['EDITH_OCR_TEXT', 'Description', 'Comment'].includes(key)) {
          texts.push(buffer.toString('utf8', nul + 1, dataEnd));
        }
      }
    }
    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  return texts.join('\n').trim();
}

function extractMockJpegText(buffer) {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const segLen = buffer.readUInt16BE(offset + 2);
    if (segLen < 2 || offset + 2 + segLen > buffer.length) break;
    if (marker === 0xfe) {
      return buffer.toString('utf8', offset + 4, offset + 2 + segLen).trim();
    }
    offset += 2 + segLen;
  }
  return '';
}

async function runWindowsNativeOcr(targetPath) {
  if (process.platform !== 'win32') {
    throw new ToolError('EXTRACTION_UNSUPPORTED', 'Local WinRT OCR is supported only on Windows.');
  }
  const psPath = path.win32.join(
    process.env.SystemRoot || process.env.windir || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  // Fixed non-interpolated script reading target path strictly from EDITH_OCR_TARGET env var.
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation`1" })[0]',
    'Function Await($WinRtTask, $ResultType) {',
    '  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)',
    '  $netTask = $asTask.Invoke($null, @($WinRtTask))',
    '  $netTask.Wait(-1) | Out-Null',
    '  $netTask.Result',
    '}',
    '[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null',
    '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:EDITH_OCR_TARGET)) ([Windows.Storage.StorageFile])',
    '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
    '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
    '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
    '$ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
    '$res = Await ($ocr.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
    'Write-Output $res.Text'
  ].join('\n');

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await exec(
    psPath,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 12000, env: { ...process.env, EDITH_OCR_TARGET: targetPath } }
  );
  return String(stdout || '').trim();
}

export async function parseImageOcrDocument({ buffer, filePath, extension, ocrEnabled = false }) {
  validateImageMagic(buffer, extension);
  if (!ocrEnabled) {
    return {
      parser: 'ocr-skipped',
      skipped: true,
      text: '',
      tables: [],
      warnings: ['OCR is opt-in. Enable OCR for this collection or upload to extract text from PNG/JPG images.']
    };
  }

  if (process.env.NODE_ENV === 'test' && process.env.EDITH_KNOWLEDGE_MOCK_OCR === '1') {
    const extracted = extension === '.png' ? extractMockPngText(buffer) : extractMockJpegText(buffer);
    return {
      parser: 'ocr-local',
      skipped: false,
      text: extracted,
      tables: [],
      warnings: extracted ? [] : ['No recognizable text detected in image.']
    };
  }

  let tempFile = null;
  let targetPath = filePath;
  try {
    if (!targetPath) {
      tempFile = path.join(os.tmpdir(), `edith-ocr-${randomUUID()}${extension}`);
      await writeFile(tempFile, buffer);
      targetPath = tempFile;
    }
    const text = await runWindowsNativeOcr(targetPath);
    return {
      parser: 'ocr-local',
      skipped: false,
      text,
      tables: [],
      warnings: text ? [] : ['Local Windows OCR completed with no text detected in image.']
    };
  } finally {
    if (tempFile) {
      await unlink(tempFile).catch(() => {});
    }
  }
}
