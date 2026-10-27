import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import JSZip from 'jszip';
import path from 'path';
import { randomUUID } from 'crypto';
import { RustfsService } from '../../storage/rustfs.service';
import { cleanMarkdown, getExtension } from './utils/markdown.util';

export interface MineruParseInput {
  originalname: string;
  buffer: Buffer;
}

/** MinerU 精准解析单文件上限（文档：200MB） */
const MAX_FILE_BYTES = 200 * 1024 * 1024;

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jp2: 'image/jp2',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

interface MineruEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

interface BatchCreated {
  batch_id?: string;
  file_urls?: string[];
}

interface ExtractItem {
  file_name?: string;
  state?: string;
  full_zip_url?: string;
  err_msg?: string;
  extract_progress?: {
    extracted_pages?: number;
    total_pages?: number;
  };
}

interface BatchResult {
  extract_result?: ExtractItem[];
}

/**
 * MinerU 精准解析（本地文件上传）。
 *
 * 流程对齐官方 `/api/v4/file-urls/batch`：
 * 1. 申请上传链接；
 * 2. PUT 文件（不设置 Content-Type），服务端自动开始解析；
 * 3. 轮询 batch 结果，拿到 `full_zip_url`；
 * 4. 下载 zip，读 `full.md`，把 `images/` 上传到 RustFS 并替换 Markdown 中的相对路径。
 */
@Injectable()
export class MineruParser {
  private readonly logger = new Logger(MineruParser.name);

  constructor(
    private readonly config: ConfigService,
    private readonly rustfs: RustfsService,
  ) {}

  async parse(file: MineruParseInput): Promise<string> {
    if (file.buffer.length > MAX_FILE_BYTES) {
      throw new BadRequestException('文件超过 MinerU 限制（200MB）');
    }

    const zipUrl = await this.submitAndWait(file);
    const zipBytes = await this.downloadZip(zipUrl);
    return this.markdownFromZip(zipBytes);
  }

  private async submitAndWait(file: MineruParseInput): Promise<string> {
    const token = this.token();
    const base = this.baseUrl();
    const fileName = path.posix.basename(file.originalname) || `file.${getExtension(file.originalname)}`;
    const extension = getExtension(fileName);
    const dataId = randomUUID();

    const created = await this.requestJson<BatchCreated>(
      `${base}/api/v4/file-urls/batch`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: [
            {
              name: fileName,
              data_id: dataId,
              is_ocr: isImageExtension(extension),
            },
          ],
          model_version: this.config.get<string>('MINERU_MODEL_VERSION', 'vlm'),
          enable_formula: this.boolConfig('MINERU_ENABLE_FORMULA', true),
          enable_table: this.boolConfig('MINERU_ENABLE_TABLE', true),
          language: this.config.get<string>('MINERU_LANGUAGE', 'ch'),
        }),
      },
    );

    const batchId = created.batch_id;
    const uploadUrl = created.file_urls?.[0];
    if (!batchId || !uploadUrl) {
      throw new BadRequestException('MinerU 未返回上传链接');
    }

    this.logger.log(`MinerU 已申请上传: batch=${batchId}, name=${fileName}`);
    await this.uploadFile(uploadUrl, file.buffer);

    const interval = this.numberConfig('MINERU_POLL_INTERVAL_MS', 3000);
    const timeout = this.numberConfig('MINERU_POLL_TIMEOUT_MS', 600_000);
    const deadline = Date.now() + timeout;
    let lastState = '';

    while (Date.now() < deadline) {
      let items: ExtractItem[] = [];
      try {
        const result = await this.requestJson<BatchResult>(
          `${base}/api/v4/extract-results/batch/${batchId}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        items = result.extract_result ?? [];
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`MinerU 轮询失败，稍后重试: ${message}`);
      }

      const item = items[0];
      const state = item?.state ?? 'waiting';
      if (state !== lastState) {
        const progress = item?.extract_progress;
        const pages =
          progress?.total_pages != null
            ? ` ${progress.extracted_pages ?? 0}/${progress.total_pages}`
            : '';
        this.logger.log(`MinerU 解析状态: batch=${batchId}, state=${state}${pages}`);
        lastState = state;
      }

      if (item?.state === 'done') {
        if (!item.full_zip_url) {
          throw new BadRequestException('MinerU 解析完成但未返回结果压缩包');
        }
        return item.full_zip_url;
      }
      if (item?.state === 'failed') {
        throw new BadRequestException(
          `MinerU 解析失败: ${item.err_msg || '未知错误'}`,
        );
      }

      await sleep(interval);
    }

    throw new BadRequestException(
      `MinerU 解析超时（${Math.round(timeout / 1000)}s），请稍后重试`,
    );
  }

  /** 官方要求上传时不要带 Content-Type，否则签名链接可能拒绝 */
  private async uploadFile(uploadUrl: string, bytes: Buffer): Promise<void> {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new BadRequestException(
        `MinerU 文件上传失败（${response.status}）${detail.slice(0, 180)}`,
      );
    }
  }

  private async downloadZip(zipUrl: string): Promise<Buffer> {
    const response = await fetch(zipUrl, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new BadRequestException(
        `下载 MinerU 解析结果失败（${response.status}）`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) {
      throw new BadRequestException('MinerU 解析结果压缩包为空');
    }
    this.logger.log(`MinerU 结果已下载: bytes=${bytes.length}`);
    return bytes;
  }

  private async markdownFromZip(zipBytes: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(zipBytes);
    const mdEntry = Object.values(zip.files).find(
      (entry) => !entry.dir && /(^|\/)full\.md$/i.test(entry.name),
    );
    if (!mdEntry) {
      throw new BadRequestException('MinerU 结果中没有 full.md');
    }

    const markdown = await mdEntry.async('string');
    const imageEntries = Object.values(zip.files).filter((entry) => {
      if (!isZipImage(entry.name, entry.dir)) return false;
      const rel = relativeImagePath(mdEntry.name, entry.name);
      return markdown.includes(rel) || markdown.includes(`./${rel}`);
    });

    if (!imageEntries.length) {
      return cleanMarkdown(markdown);
    }

    if (!this.rustfs.isEnabled()) {
      throw new BadRequestException(
        '解析结果包含图片，但 RustFS 未启用，无法替换图片地址',
      );
    }

    const urlByPath = new Map<string, string>();
    for (const entry of imageEntries) {
      const rel = relativeImagePath(mdEntry.name, entry.name);
      const bytes = await entry.async('nodebuffer');
      const ext = getExtension(entry.name);
      const url = await this.rustfs.uploadBytes(bytes, {
        fileName: path.posix.basename(entry.name),
        contentType: IMAGE_CONTENT_TYPES[ext] ?? 'application/octet-stream',
        prefix: 'document-images',
      });
      urlByPath.set(rel, url);
    }

    this.logger.log(`MinerU 图片已上传 RustFS: count=${urlByPath.size}`);
    return cleanMarkdown(rewriteImageUrls(markdown, urlByPath));
  }

  private async requestJson<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: MineruEnvelope<T> | null = null;
    try {
      body = text ? (JSON.parse(text) as MineruEnvelope<T>) : null;
    } catch {
      body = null;
    }

    if (!response.ok || !body || body.code !== 0 || body.data == null) {
      const reason = body?.msg || text.slice(0, 180) || response.statusText;
      throw new BadRequestException(
        `MinerU 接口失败（${response.status}）: ${reason}`,
      );
    }
    return body.data;
  }

  private token(): string {
    const token = this.config.get<string>('MINERU_API_TOKEN')?.trim();
    if (!token) {
      throw new BadRequestException('未配置 MINERU_API_TOKEN，无法解析文件');
    }
    return token;
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('MINERU_API_BASE') || 'https://mineru.net'
    ).replace(/\/$/, '');
  }

  private numberConfig(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    const value = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private boolConfig(key: string, fallback: boolean): boolean {
    const raw = this.config.get<string | boolean>(key);
    if (raw == null || raw === '') return fallback;
    if (typeof raw === 'boolean') return raw;
    return raw.toLowerCase() !== 'false';
  }
}

function isImageExtension(extension: string): boolean {
  return Object.prototype.hasOwnProperty.call(IMAGE_CONTENT_TYPES, extension);
}

function isZipImage(name: string, dir: boolean): boolean {
  if (dir) return false;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.includes('__MACOSX/') || normalized.endsWith('.DS_Store')) {
    return false;
  }
  if (!/(^|\/)images\/[^/]+$/i.test(normalized)) return false;
  return isImageExtension(getExtension(normalized));
}

/** 相对 full.md 所在目录的路径，与 Markdown 里的 `images/...` 对齐 */
function relativeImagePath(mdEntryName: string, imageEntryName: string): string {
  const mdPath = mdEntryName.replace(/\\/g, '/');
  const imagePath = imageEntryName.replace(/\\/g, '/');
  const mdDir = path.posix.dirname(mdPath);
  const rel = path.posix.relative(mdDir === '.' ? '' : mdDir, imagePath);
  if (rel && !rel.startsWith('..')) return rel;
  const idx = imagePath.toLowerCase().lastIndexOf('images/');
  return idx >= 0 ? imagePath.slice(idx) : path.posix.basename(imagePath);
}

/** 把 Markdown / HTML 中的 `images/xxx` 换成 RustFS 地址 */
export function rewriteImageUrls(
  markdown: string,
  urlByPath: Map<string, string>,
): string {
  const replacements: Array<[string, string]> = [];
  for (const [rel, url] of urlByPath) {
    const normalized = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    replacements.push([`./${normalized}`, url], [normalized, url]);
  }
  replacements.sort((a, b) => b[0].length - a[0].length);

  let result = markdown;
  for (const [from, url] of replacements) {
    if (result.includes(from)) {
      result = result.split(from).join(url);
    }
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
