import { CloudError } from './cloud';

/** 只提取固定类别与 HTTP 状态，不保留 SDK 正文、URL 或授权信息。 */
export function photoUploadError(failure?: any, statusCode?: number): CloudError & { statusCode?: number } {
  const message = String(failure?.errMsg || failure?.message || '');
  let code = 'PHOTO_UPLOAD';
  if (statusCode === 401 || statusCode === 403) code = 'PHOTO_AUTH';
  else if (statusCode === 408 || statusCode === 504) code = 'PHOTO_TIMEOUT';
  else if (statusCode === 413) code = 'PHOTO_CAPACITY';
  else if (statusCode === 429 || statusCode >= 500) code = 'PHOTO_SERVICE';
  else if (/url not in domain list|domain.*(?:not.*(?:allow|list)|illegal)|不在.*合法域名|域名.*(?:未配置|不合法)/i.test(message)) code = 'PHOTO_DOMAIN';
  else if (/timeout|timed out|超时/i.test(message)) code = 'PHOTO_TIMEOUT';
  else if (/ssl|tls|certificate|证书/i.test(message)) code = 'PHOTO_TLS';
  else if (/network|connection|internet|网络|连接/i.test(message)) code = 'PHOTO_NETWORK';
  const error: CloudError & { statusCode?: number } = new CloudError(code, '照片上传失败，请重试');
  if (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) error.statusCode = statusCode;
  return error;
}

export function photoStageError(error: any, stage: string): any {
  if (error?.code !== 'INVALID') return error;
  if (stage === 'prepare' && error.message === '不支持的操作') return new CloudError('PHOTO_CONFIG', '照片上传接口尚未更新');
  if (stage === 'complete' && /^请选择支持的照片格式/.test(error.message)) return new CloudError('PHOTO_FORMAT', '照片格式不支持');
  if (stage === 'complete' && error.message === '照片上传已过期，请重试') return new CloudError('PHOTO_EXPIRED', '照片上传已过期');
  return error;
}
