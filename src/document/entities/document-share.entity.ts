import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer';

/** 已发布文档的分享链接。password_hash 为空表示无需密码。 */
@Entity('kh_document_share')
export class DocumentShareEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  @Column({
    name: 'document_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  documentId: string;

  /** 分享链接里的短码，库字段名是 token */
  @Column({ type: 'varchar', length: 64, unique: true })
  token: string;

  @Column({ name: 'require_password', type: 'boolean', default: false })
  requirePassword: boolean;

  @Column({ name: 'password_hash', type: 'varchar', length: 255, nullable: true })
  passwordHash?: string | null;

  @Column({ name: 'expire_at', type: 'timestamp', nullable: true })
  expireAt?: Date | null;

  @Column({ name: 'created_by', type: 'bigint', transformer: bigintTransformer })
  createdBy: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @Column({ type: 'boolean', default: false })
  revoked: boolean;
}
