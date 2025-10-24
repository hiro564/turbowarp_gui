class TileCache {
    constructor() {
        this.cache = new Map();
        this.maxSize = 200; // キャッシュサイズ上限
        // 建物・道路が強調されたタイルサーバーを使用
        this.baseUrl = 'https://cartodb-basemaps-a.global.ssl.fastly.net/light_all/{z}/{x}/{y}.png';
    }

    // タイルのキーを生成
    getTileKey(zoom, x, y) {
        return `${zoom}_${x}_${y}`;
    }

    // タイル画像を取得（キャッシュ機能付き）
    async getImage(zoom, x, y) {
        const key = this.getTileKey(zoom, x, y);
        
        // キャッシュから取得を試行
        if (this.cache.has(key)) {
            const cachedImage = this.cache.get(key);
            if (cachedImage.complete) {
                return cachedImage;
            }
        }

        // キャッシュになければ新しく取得
        try {
            const url = this.getTileUrl(zoom, x, y);
            const image = await this.loadImage(url);
            
            // キャッシュに保存
            this.cache.set(key, image);
            
            // キャッシュサイズ管理
            this.manageCacheSize();
            
            return image;
        } catch (error) {
            console.error(`Failed to load tile: ${key}`, error);
            
            // フォールバック: 標準OpenStreetMapタイルを試行
            try {
                const fallbackUrl = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
                const fallbackImage = await this.loadImage(fallbackUrl);
                this.cache.set(key, fallbackImage);
                this.manageCacheSize();
                return fallbackImage;
            } catch (fallbackError) {
                console.error(`Fallback tile also failed: ${key}`, fallbackError);
                return null;
            }
        }
    }

    // 建物・道路が強調され、彩度が高いタイルのURLを生成
    getTileUrl(zoom, x, y) {
        return this.baseUrl
            .replace('{z}', zoom)
            .replace('{x}', x)
            .replace('{y}', y);
    }

    // 画像を非同期で読み込み
    loadImage(url) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.crossOrigin = 'anonymous'; // CORS対応
            
            image.onload = () => {
                resolve(image);
            };
            
            image.onerror = (error) => {
                reject(error);
            };
            
            // タイムアウト設定（10秒）
            setTimeout(() => {
                if (!image.complete) {
                    reject(new Error('Image load timeout'));
                }
            }, 10000);
            
            image.src = url;
        });
    }

    // キャッシュサイズを管理
    manageCacheSize() {
        if (this.cache.size > this.maxSize) {
            // 古いエントリから削除（簡易的なLRU）
            const keysToDelete = Array.from(this.cache.keys()).slice(0, this.cache.size - this.maxSize);
            keysToDelete.forEach(key => this.cache.delete(key));
        }
    }

    // キャッシュをクリア
    clearCache() {
        this.cache.clear();
    }

    // キャッシュサイズを設定
    setMaxCacheSize(size) {
        this.maxSize = size;
        this.manageCacheSize();
    }

    // キャッシュ状態を取得
    getCacheStats() {
        return {
            currentSize: this.cache.size,
            maxSize: this.maxSize
        };
    }
}

module.exports = TileCache;