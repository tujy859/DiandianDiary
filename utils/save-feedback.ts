/** 保存入口只展示可控文案，SDK / 服务商错误原文不直接进入用户提示。 */
export function diarySaveMessage(error: any): string {
  switch (error?.code) {
    case 'PHOTO_READ': return '照片暂时无法读取，请重试';
    case 'PHOTO_UPLOAD': return '照片暂未上传成功，请稍后重试；持续失败请联系开发者';
    case 'PHOTO_NETWORK': return '照片上传连接中断，请网络稳定后重试';
    case 'PHOTO_TIMEOUT': return '照片上传超时，请稍后重试';
    case 'PHOTO_DOMAIN':
    case 'PHOTO_CONFIG': return '照片上传服务尚未配置完成，请联系开发者处理';
    case 'PHOTO_AUTH': return '云端拒绝了照片上传，请重试；持续失败请联系开发者';
    case 'PHOTO_TLS': return '无法安全连接照片服务，请稍后重试；持续失败请联系开发者';
    case 'PHOTO_SERVICE': return '照片服务暂时繁忙，请稍后重试';
    case 'PHOTO_CAPACITY': return '照片超过当前上传服务可接收的大小，请选择较小的照片';
    case 'PHOTO_FORMAT': return '暂不支持这张照片的格式，请改选 JPG、PNG 等照片';
    case 'PHOTO_EXPIRED': return '本次照片上传已过期，请重新保存';
    case 'SESSION_CHANGED': return '账号或家庭已切换，请回到当前家庭后重试';
    case 'UNAUTHENTICATED': return '登录已失效，请重新登录后保存';
    case 'NO_FAMILY': return '请先创建或加入家庭，再保存日记';
    case 'FORBIDDEN': return '当前家庭访问权限已变化，请刷新后重试';
    case 'CONFLICT': return '这条记录已有新内容，请刷新后再保存';
    case 'INVALID': return '记录内容未通过检查，请检查日期、文字和照片后重试';
    case 'NOT_FOUND': return '这条记录或宠物已不存在，请刷新后重试';
    case 'MEDIA_UNAVAILABLE': return '照片暂时无法显示，请刷新确认日记保存结果';
    default: return '暂时无法确认保存结果，请稍后重试';
  }
}

export function diarySaveFeedback(error: any, stage = ''): { title: string; message: string } {
  const code = String(error?.code || '');
  const title = code === 'PHOTO_READ' ? '照片读取失败'
    : code === 'PHOTO_DOMAIN' || code === 'PHOTO_CONFIG' ? '照片服务配置异常'
    : code === 'PHOTO_AUTH' ? '照片上传授权失败'
    : code === 'PHOTO_TIMEOUT' ? '照片上传超时'
    : code.startsWith('PHOTO_') ? '照片上传未完成'
    : stage === 'confirm' ? '照片云端确认未完成'
    : stage === 'refresh' ? '日记已写入，显示确认未完成'
    : '日记保存未完成';
  const message = stage === 'refresh'
    ? '云端已确认写入日记，但暂时无法刷新照片显示。请到时光册刷新查看。'
    : stage === 'confirm' && !code.startsWith('PHOTO_') && !['SESSION_CHANGED', 'FORBIDDEN', 'UNAUTHENTICATED'].includes(code)
      ? '照片已传送，但云端尚未确认完成。草稿和照片已保留，请稍后重试。'
      : `${diarySaveMessage(error)}。草稿和照片已保留。`;
  return { title, message };
}
