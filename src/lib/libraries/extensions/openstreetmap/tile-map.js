class TileMap {
    constructor() {
        this.centerLongitude = 139.691648; // 初期経度(東京)
        this.centerLatitude = 35.689185;   // 初期緯度(東京)
        this.currentZoom = 16;             // 初期ズームレベル（小数点可能）
        this.tiles = [];
        this.zoomOffset = 0;
        
        // 建物・道路が強調されたタイルサーバーを使用
        // CartoDB Positronスタイル - 建物が明確に見えるシンプルなスタイル
        this.tileServerUrl = 'https://cartodb-basemaps-a.global.ssl.fastly.net/light_all/{z}/{x}/{y}.png';
        
        // ズーム段階の設定（0.25刻みで細かく調整可能）
        this.zoomLevels = this.generateZoomLevels(10, 20, 0.25);
    }

    // ズームレベル配列を生成（minから maxまでstep刻み）
    generateZoomLevels(min, max, step) {
        const levels = [];
        for (let zoom = min; zoom <= max; zoom += step) {
            levels.push(Math.round(zoom * 100) / 100); // 小数点2桁で丸める
        }
        return levels;
    }

    // 現在のズームから最も近い有効なズームレベルを取得
    getNearestValidZoom(targetZoom) {
        return this.zoomLevels.reduce((prev, curr) => 
            Math.abs(curr - targetZoom) < Math.abs(prev - targetZoom) ? curr : prev
        );
    }

    // ズームレベルを段階的に変更するメソッド
    zoomIn() {
        const currentIndex = this.zoomLevels.indexOf(this.currentZoom);
        if (currentIndex < this.zoomLevels.length - 1) {
            this.currentZoom = this.zoomLevels[currentIndex + 1];
        }
        return this.currentZoom;
    }

    zoomOut() {
        const currentIndex = this.zoomLevels.indexOf(this.currentZoom);
        if (currentIndex > 0) {
            this.currentZoom = this.zoomLevels[currentIndex - 1];
        }
        return this.currentZoom;
    }

    // ズームレベルを直接設定
    setZoom(zoom) {
        this.currentZoom = this.getNearestValidZoom(zoom);
        return this.currentZoom;
    }

    setZoomOffset(offset) {
        this.zoomOffset = offset;
    }

    buildTiles(zoom, longitude, latitude, width, height) {
        this.centerLatitude = latitude;
        this.centerLongitude = longitude;
        this.currentZoom = zoom;
        
        // 小数点ズームの場合、タイル取得用の整数ズームレベルを決定
        const baseZoom = Math.floor(zoom);
        const zoomFraction = zoom - baseZoom;
        
        // タイル計算は整数ズームレベルで行う
        const tile = this.latLonToTile(latitude, longitude, baseZoom);
        const pixelPoint = this.latLonToPixel(latitude, longitude, baseZoom);
        
        const halfWidth = width / 2;
        const halfHeight = height / 2;
        const TILE_SIZE = 256;
        
        // 小数点ズーム分のスケール調整
        const scale = Math.pow(2, zoomFraction);
        const scaledTileSize = TILE_SIZE * scale;
        
        const minTileX = Math.floor((pixelPoint.x - halfWidth / scale) / TILE_SIZE);
        const maxTileX = Math.ceil((pixelPoint.x + halfWidth / scale) / TILE_SIZE);
        const minTileY = Math.floor((pixelPoint.y - halfHeight / scale) / TILE_SIZE);
        const maxTileY = Math.ceil((pixelPoint.y + halfHeight / scale) / TILE_SIZE);
        
        this.tiles = [];
        
        for (let y = minTileY; y < maxTileY; y++) {
            for (let x = minTileX; x < maxTileX; x++) {
                const normalizedX = (x + Math.pow(2, baseZoom)) % Math.pow(2, baseZoom);
                
                // 小数点ズーム分のスケール調整を適用
                const screenX = (normalizedX - minTileX) * scaledTileSize - 
                              ((pixelPoint.x - halfWidth / scale - minTileX * TILE_SIZE) * scale);
                const screenY = (y - minTileY) * scaledTileSize - 
                              ((pixelPoint.y - halfHeight / scale - minTileY * TILE_SIZE) * scale);
                
                this.tiles.push({
                    x: normalizedX,
                    y: y,
                    zoom: baseZoom,
                    actualZoom: zoom, // 実際の小数点ズームレベル
                    screenX: Math.round(screenX),
                    screenY: Math.round(screenY),
                    scale: scale, // 描画時のスケール
                    url: this.getTileUrl(normalizedX, y, baseZoom)
                });
            }
        }
    }

    // より高解像度な次のズームレベルのタイルも取得（オプション）
    buildTilesWithInterpolation(zoom, longitude, latitude, width, height) {
        const baseZoom = Math.floor(zoom);
        const nextZoom = baseZoom + 1;
        const zoomFraction = zoom - baseZoom;
        
        // 基本ズームのタイルを構築
        this.buildTiles(zoom, longitude, latitude, width, height);
        const baseTiles = [...this.tiles];
        
        // 次のズームレベルのタイルも取得（より詳細な情報用）
        if (zoomFraction > 0.5) {
            this.buildTiles(nextZoom, longitude, latitude, width, height);
            const nextTiles = this.tiles.map(tile => ({
                ...tile,
                isHighRes: true,
                opacity: zoomFraction // 透明度で補間
            }));
            
            // 両方のタイルセットを結合
            this.tiles = [...baseTiles, ...nextTiles];
        }
    }

    // 建物・道路が強調され、彩度が高いタイルURLを生成
    getTileUrl(x, y, zoom) {
        return this.tileServerUrl
            .replace('{z}', zoom)
            .replace('{x}', x)
            .replace('{y}', y);
    }

    latLonToTile(lat, lon, zoom) {
        const x = Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
        const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 
            1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
        return { x: x, y: y };
    }

    latLonToPixel(lat, lon, zoom) {
        const TILE_SIZE = 256;
        const scale = Math.pow(2, zoom);
        const x = (lon + 180) / 360 * scale * TILE_SIZE;
        const y = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 
            1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * scale * TILE_SIZE;
        
        return { x: x, y: y };
    }

    // 現在利用可能なズームレベル一覧を取得
    getAvailableZoomLevels() {
        return this.zoomLevels;
    }

    // デバッグ用：現在の設定を表示
    getDebugInfo() {
        return {
            currentZoom: this.currentZoom,
            availableZooms: this.zoomLevels.length,
            zoomRange: `${this.zoomLevels[0]} - ${this.zoomLevels[this.zoomLevels.length - 1]}`,
            step: this.zoomLevels[1] - this.zoomLevels[0]
        };
    }
}

module.exports = TileMap;