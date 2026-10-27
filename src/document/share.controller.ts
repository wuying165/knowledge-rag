import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { DocumentShareService } from './document-share.service';
import { AccessShareDto } from './dto/social.dto';

/** 分享链接对外访问，不要求登录 */
@Controller('shares')
export class ShareController {
  constructor(private readonly shares: DocumentShareService) {}

  @Public()
  @Get(':code')
  preview(@Param('code') code: string) {
    return this.shares.preview(code);
  }

  @Public()
  @Post(':code/access')
  access(@Param('code') code: string, @Body() dto: AccessShareDto) {
    return this.shares.access(code, dto);
  }
}
