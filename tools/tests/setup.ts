/**
 * 测试环境：注入微信小程序 API 的内存实现（Storage / 文件系统 / request 等）。
 * 目的是让 utils 下的代码可以在 Node 里原样运行，测试的就是真实业务代码。
 */
const storage: Record<string, any> = {};
const savedFiles: string[] = [];

const wxStub: any = {
  env: { USER_DATA_PATH: '/tmp/jd-user-data' },

  getStorageSync(key: string) {
    return key in storage ? storage[key] : '';
  },
  setStorageSync(key: string, value: any) {
    storage[key] = value;
  },
  removeStorageSync(key: string) {
    delete storage[key];
  },
  clearStorageSync() {
    Object.keys(storage).forEach((k) => delete storage[k]);
  },
  getStorageInfoSync() { return { keys: Object.keys(storage) }; },

  getFileSystemManager() {
    return {
      accessSync: () => undefined,
      mkdirSync: () => undefined,
      saveFile: ({ filePath, success, fail }: any) => {
        savedFiles.push(filePath);
        success && success({ savedFilePath: filePath });
      },
    };
  },

  // 网络：测试默认不发起真实请求，测试文件按需覆盖
  request: (opts: any) => {
    opts && opts.fail && opts.fail({ errMsg: 'request:fail 测试环境默认不发起网络请求' });
  },

  compressImage: (opts: any) => {
    opts && opts.fail && opts.fail({ errMsg: 'compressImage:fail' });
  },

  showLoading: () => undefined,
  hideLoading: () => undefined,
  showToast: () => undefined,
  previewImage: () => undefined,
  chooseMedia: () => undefined,
  switchTab: () => undefined,
  navigateTo: () => undefined,
  navigateBack: () => undefined,
  reLaunch: () => undefined,
  redirectTo: () => undefined,
};

(global as any).wx = wxStub;
(global as any).__wxStub = wxStub; // 供测试替换 request 等行为
(global as any).__savedFiles = savedFiles;
(global as any).Page = (options: any) => options;
(global as any).Component = (options: any) => options;
(global as any).App = (options: any) => options;
(global as any).getApp = () => ({ globalData: {} });

export {};
