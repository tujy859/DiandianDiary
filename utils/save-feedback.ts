/** 保存入口只展示可控文案，SDK / 服务商错误原文不直接进入用户提示。 */
export function diarySaveMessage(error: any): string {
  switch (error?.code) {
    case 'PHOTO_READ': return '照片暂时无法读取，请重试';
    case 'PHOTO_UPLOAD': return '照片暂未上传成功，请检查网络后重试';
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
