// 本地开发环境下的 KV 模拟器
export class KVMock {
  private store: Map<string, any> = new Map();

  async get(key: string): Promise<any> {
    const value = this.store.get(key);
    if (value === undefined) {
      return null;
    }

    // 模拟 KV 的 JSON 解析
    try {
      return typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
      return value;
    }
  }

  async put(key: string, value: any): Promise<void> {
    // 模拟 KV 的 JSON 序列化
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    this.store.set(key, serialized);

    // 同时保存到 localStorage 以便持久化
    localStorage.setItem(`kv_mock_${key}`, serialized);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    localStorage.removeItem(`kv_mock_${key}`);
  }

  async list(): Promise<string[]> {
    return Array.from(this.store.keys());
  }

  // 从 localStorage 恢复数据
  restore() {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith('kv_mock_')) {
        const kvKey = key.replace('kv_mock_', '');
        const value = localStorage.getItem(key);
        if (value) {
          this.store.set(kvKey, value);
        }
      }
    });
  }

  // 清空所有数据
  clear() {
    this.store.clear();
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith('kv_mock_')) {
        localStorage.removeItem(key);
      }
    });
  }
}

// 导出单例实例
export const kvMock = new KVMock();

// 在应用启动时恢复数据
if (typeof window !== 'undefined') {
  kvMock.restore();
}