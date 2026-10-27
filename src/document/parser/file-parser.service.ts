import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MineruParser } from './mineru.parser';
import { parsePlainText } from './parsers/plain-text.parser';
import { getExtension } from './utils/markdown.util';

/**
 * MinerU 精准解析支持的扩展名。
 * 见 https://mineru.net/apiManage/docs ：PDF、图片、Doc/Docx、Ppt/PPTx、Xls/Xlsx。
 */
const MINERU_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'jp2',
  'webp',
  'gif',
  'bmp',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
]);

/** txt / md 本地直读，不走 MinerU */
const LOCAL_TEXT_EXTENSIONS = new Set(['txt', 'md']);

const SUPPORTED_EXTENSIONS = new Set([
  ...MINERU_EXTENSIONS,
  ...LOCAL_TEXT_EXTENSIONS,
]);

export interface ParseInput {
  originalname: string;
  buffer: Buffer;
  size?: number;
}

/**
 * 文件 → Markdown 解析服务。
 *
 * PDF / 图片 / Office 走 MinerU，结果 zip 里的图片上传 RustFS 并回写 Markdown。
 * txt / md 按 UTF-8 原样读出。
 */
@Injectable()
export class FileParserService {
  private readonly logger = new Logger(FileParserService.name);

  constructor(private readonly mineru: MineruParser) {}

  /** 是否为已支持的扩展名（大小写不敏感） */
  isSupported(extension: string): boolean {
    return SUPPORTED_EXTENSIONS.has(extension?.toLowerCase());
  }

  /** 逗号分隔的支持格式列表，用于错误提示 */
  supportedList(): string {
    return [...SUPPORTED_EXTENSIONS].join(', ');
  }

  /**
   * 将上传文件解析为 Markdown 字符串。
   *
   * - pdf / 图片 / doc(x) / ppt(x) / xls(x)：MinerU 精准解析
   * - txt / md：本地读取
   */
  async parse(file: ParseInput): Promise<string> {
    const extension = getExtension(file.originalname);

    if (!this.isSupported(extension)) {
      throw new BadRequestException(
        `不支持的文件格式: ${extension || '(无扩展名)'}，支持的格式: ${this.supportedList()}`,
      );
    }

    if (!file.buffer?.length) {
      throw new BadRequestException('文件内容为空，无法解析');
    }

    const start = Date.now();
    const result = MINERU_EXTENSIONS.has(extension)
      ? await this.mineru.parse(file)
      : parsePlainText(file.buffer);

    const elapsed = Date.now() - start;
    this.logger.log(
      `文件解析完成: name=${file.originalname}, format=${extension}, chars=${result.length}, elapsed=${elapsed}ms`,
    );

    if (!result?.trim()) {
      throw new BadRequestException(
        '文件解析结果为空，请确认文件包含可提取的文本内容',
      );
    }

    return result;
  }
}
