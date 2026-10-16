/** 使用 CloudBase 官方 SDK 签发 PUT 上传地址；读写规则仍保持仅管理员。 */
function storageAdapter(cloud, client) {
  return {
    uploadFile: (options) => cloud.uploadFile(options),
    downloadFile: (options) => cloud.downloadFile(options),
    deleteFile: (options) => cloud.deleteFile(options),
    getTempFileURL: (options) => cloud.getTempFileURL(options),
    async prepareUpload(cloudPath) {
      const response = await client.getUploadMetadata({ cloudPath });
      if (response.code) throw new Error('Upload metadata unavailable');
      const { url, token, authorization, fileId, cosFileId } = response.data || {};
      if (!/^https:\/\//.test(url || '') || !fileId || !token || !authorization || !cosFileId) throw new Error('Invalid upload metadata');
      return { fileId, url, headers: {
        Signature: authorization, authorization,
        'x-cos-security-token': token, 'x-cos-meta-fileid': cosFileId,
        key: encodeURIComponent(cloudPath), 'content-type': 'application/octet-stream',
      } };
    },
  };
}
module.exports = { storageAdapter };
