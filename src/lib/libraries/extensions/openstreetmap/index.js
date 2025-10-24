const ArgumentType = require('scratch-vm/src/extension-support/argument-type');
const BlockType = require('scratch-vm/src/extension-support/block-type');
const Cast = require('scratch-vm/src/util/cast');
const StageLayering = require('scratch-vm/src/engine/stage-layering');
const TileMap = require('./tile-map');
const TileCache = require('./tile-cache');

/**
 * OpenStreetMap 拡張機能（地図表示・座標変換のみ）
 * @param {Runtime} runtime - the runtime instantiating this block package.
 * @constructor
 */
class Scratch3OpenStreetMapBlocks {
    constructor(runtime) {
        this.runtime = runtime;

        this.mapState = {
            centerLat: null,
            centerLon: null,
            zoom: 16,
            initialized: false
        };

        this._penSkinId = -1;
        this._penDrawableId = -1;

        this.tileMap = new TileMap(runtime, this);
        this.tileCache = new TileCache();

        runtime.on('PROJECT_STOP_ALL', this.clearAll.bind(this));
        runtime.on('PROJECT_START', () => {
            console.log('PROJECT_START event received');
        });

        this.initialized = false;
    }

    /**
     * タイルの描画位置を計算
     */
    calculateTilePosition(tile, centerPixelX, centerPixelY) {
        const centerTileX = (this.mapState.centerLon + 180) / 360 * Math.pow(2, this.mapState.zoom);
        const centerTileY = (1 - Math.log(Math.tan(this.mapState.centerLat * Math.PI / 180) + 
            1 / Math.cos(this.mapState.centerLat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, this.mapState.zoom);

        const tileOffsetX = (tile.x - centerTileX) * 256;
        const tileOffsetY = (tile.y - centerTileY) * 256;

        return {
            x: centerPixelX + tileOffsetX,
            y: centerPixelY - tileOffsetY
        };
    }

    /**
     * 緯度経度をピクセル座標に変換
     */
    latLonToPixel(lat, lon) {
        if (!this.mapState.initialized) {
            return { x: 0, y: 0 };
        }

        const zoom = this.mapState.zoom;
        const centerLat = this.mapState.centerLat;
        const centerLon = this.mapState.centerLon;

        const targetTileX = (lon + 180) / 360 * Math.pow(2, zoom);
        const targetTileY = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 
            1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom);

        const centerTileX = (centerLon + 180) / 360 * Math.pow(2, zoom);
        const centerTileY = (1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 
            1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom);

        const pixelX = (targetTileX - centerTileX) * 256;
        const pixelY = -(targetTileY - centerTileY) * 256;

        return { x: pixelX, y: pixelY };
    }

    /**
     * ピクセル座標を緯度経度に変換
     */
    pixelToLatLon(pixelX, pixelY) {
        if (!this.mapState.initialized) {
            return { lat: 0, lon: 0 };
        }

        const zoom = this.mapState.zoom;
        const centerLat = this.mapState.centerLat;
        const centerLon = this.mapState.centerLon;

        const centerTileX = (centerLon + 180) / 360 * Math.pow(2, zoom);
        const centerTileY = (1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 
            1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom);

        const targetTileX = centerTileX + pixelX / 256;
        const targetTileY = centerTileY - pixelY / 256;

        const lon = targetTileX / Math.pow(2, zoom) * 360 - 180;
        const n = Math.PI - 2 * Math.PI * targetTileY / Math.pow(2, zoom);
        const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));

        return { lat: lat, lon: lon };
    }

    /**
     * 地図の表示範囲の座標を取得
     */
    getMapBounds() {
        const northWest = this.pixelToLatLon(-240, 180);
        const southEast = this.pixelToLatLon(240, -180);

        return {
            north: northWest.lat,
            south: southEast.lat,
            east: southEast.lon,
            west: northWest.lon
        };
    }

    /**
     * メートル/ピクセル比率を計算
     */
    getMetersPerPixel() {
        if (!this.mapState.initialized) {
            return 1;
        }

        const lat = this.mapState.centerLat;
        const zoom = this.mapState.zoom;
        const metersPerPixel = (156543.03392 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, zoom);
        return metersPerPixel;
    }

    /**
     * 2点間の距離を計算（メートル）
     */
    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
    }

    /**
     * 全てのクリア
     */
    clearAll() {
        console.log('Clearing all map data');
        if (this._penDrawableId >= 0) {
            this.runtime.renderer.updateDrawableProperties(this._penDrawableId, {
                visible: false
            });
        }
        this.mapState.initialized = false;
    }

    /**
     * 住所から地図を表示
     */
    async showMapFromAddress(args) {
        const address = Cast.toString(args.ADDRESS);
        const zoom = Cast.toNumber(args.ZOOM);

        try {
            const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`;
            const response = await fetch(url);
            const data = await response.json();

            if (data && data.length > 0) {
                const lat = parseFloat(data[0].lat);
                const lon = parseFloat(data[0].lon);
                return this.drawTileMap({ LATITUDE: lat, LONGITUDE: lon, ZOOM: zoom });
            } else {
                console.error('住所が見つかりませんでした:', address);
            }
        } catch (error) {
            console.error('住所検索エラー:', error);
        }
    }

    /**
     * 緯度経度から地図を表示
     */
    async drawTileMap(args) {
        const latitude = Cast.toNumber(args.LATITUDE);
        const longitude = Cast.toNumber(args.LONGITUDE);
        const zoom = Cast.toNumber(args.ZOOM);

        this.mapState = {
            centerLat: latitude,
            centerLon: longitude,
            zoom: zoom,
            initialized: true
        };

        if (this._penSkinId < 0) {
            this._penSkinId = this.runtime.renderer.createPenSkin();
            this._penDrawableId = this.runtime.renderer.createDrawable(StageLayering.PEN_LAYER);
            this.runtime.renderer.updateDrawableProperties(this._penDrawableId, {
                skinId: this._penSkinId
            });
        }

        this.runtime.renderer.penClear(this._penSkinId);

        await this.tileMap.loadAndDrawTiles(latitude, longitude, zoom);

        this.runtime.renderer.updateDrawableProperties(this._penDrawableId, {
            visible: true
        });

        this.runtime.requestRedraw();
    }

    /**
     * 地図を移動
     */
    moveMap(args) {
        if (!this.mapState.initialized) return;

        const direction = Cast.toString(args.DIRECTION);
        const moveAmount = 0.01;

        switch (direction) {
            case '上':
                this.mapState.centerLat += moveAmount;
                break;
            case '下':
                this.mapState.centerLat -= moveAmount;
                break;
            case '左':
                this.mapState.centerLon -= moveAmount;
                break;
            case '右':
                this.mapState.centerLon += moveAmount;
                break;
        }

        return this.drawTileMap({
            LATITUDE: this.mapState.centerLat,
            LONGITUDE: this.mapState.centerLon,
            ZOOM: this.mapState.zoom
        });
    }

    /**
     * レポーターブロックの実装
     */
    getCurrentLatitude(args, util) {
        const targetId = util.target.id;
        const target = this.runtime.getTargetById(targetId);
        if (!target) return 0;

        const result = this.pixelToLatLon(target.x, target.y);
        return result.lat;
    }

    getCurrentLongitude(args, util) {
        const targetId = util.target.id;
        const target = this.runtime.getTargetById(targetId);
        if (!target) return 0;

        const result = this.pixelToLatLon(target.x, target.y);
        return result.lon;
    }

    getDistanceScale() {
        return this.getMetersPerPixel();
    }

    calculateDistanceBetweenPoints(args) {
        const lat1 = Cast.toNumber(args.LATITUDE1);
        const lon1 = Cast.toNumber(args.LONGITUDE1);
        const lat2 = Cast.toNumber(args.LATITUDE2);
        const lon2 = Cast.toNumber(args.LONGITUDE2);

        return this.calculateDistance(lat1, lon1, lat2, lon2);
    }

    getNorthLatitude() {
        const bounds = this.getMapBounds();
        return bounds.north;
    }

    getSouthLatitude() {
        const bounds = this.getMapBounds();
        return bounds.south;
    }

    getEastLongitude() {
        const bounds = this.getMapBounds();
        return bounds.east;
    }

    getWestLongitude() {
        const bounds = this.getMapBounds();
        return bounds.west;
    }

    getLatitudeFromCoordinates(args) {
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        const result = this.pixelToLatLon(x, y);
        return result.lat;
    }

    getLongitudeFromCoordinates(args) {
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        const result = this.pixelToLatLon(x, y);
        return result.lon;
    }

    getXFromCoordinates(args) {
        const lat = Cast.toNumber(args.LATITUDE);
        const lon = Cast.toNumber(args.LONGITUDE);
        const result = this.latLonToPixel(lat, lon);
        return result.x;
    }

    getYFromCoordinates(args) {
        const lat = Cast.toNumber(args.LATITUDE);
        const lon = Cast.toNumber(args.LONGITUDE);
        const result = this.latLonToPixel(lat, lon);
        return result.y;
    }

    /**
     * ブロック定義
     */
    getInfo() {
        return {
            id: 'osm',
            name: 'OpenStreetMap',
            blocks: [
                {
                    opcode: 'showMapFromAddress',
                    blockType: BlockType.COMMAND,
                    text: '住所 [ADDRESS] の地図をズームレベル [ZOOM] で表示',
                    arguments: {
                        ADDRESS: {
                            type: ArgumentType.STRING,
                            defaultValue: '神奈川県鎌倉市雪ノ下3丁目5-10'
                        },
                        ZOOM: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 16
                        }
                    }
                },
                {
                    opcode: 'drawTileMap',
                    blockType: BlockType.COMMAND,
                    text: '緯度[LATITUDE] 経度[LONGITUDE] の地図をズームレベル [ZOOM] で表示',
                    arguments: {
                        LATITUDE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 35.3251096
                        },
                        LONGITUDE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 139.558511
                        },
                        ZOOM: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 16
                        }
                    }
                },
                {
                    opcode: 'moveMap',
                    text: '地図を [DIRECTION] 方向に動かす',
                    blockType: BlockType.COMMAND,
                    arguments: {
                        DIRECTION: {
                            type: ArgumentType.STRING,
                            menu: 'directions',
                            defaultValue: '上'
                        }
                    }
                },
                {
                    opcode: 'getCurrentLatitude',
                    blockType: BlockType.REPORTER,
                    text: 'スプライトがいる場所の緯度',
                    arguments: {}
                },
                {
                    opcode: 'getCurrentLongitude',
                    blockType: BlockType.REPORTER,
                    text: 'スプライトがいる場所の経度',
                    arguments: {}
                },
                {
                    opcode: 'getDistanceScale',
                    blockType: BlockType.REPORTER,
                    text: '1pxが実際の何メートルに相当するか',
                    arguments: {}
                },
                {
                    opcode: 'calculateDistanceBetweenPoints',
                    blockType: BlockType.REPORTER,
                    text: '緯度[LATITUDE1]経度[LONGITUDE1]から緯度[LATITUDE2]経度[LONGITUDE2]までの距離(m)',
                    arguments: {
                        LATITUDE1: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 35.689185
                        },
                        LONGITUDE1: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 139.691648
                        },
                        LATITUDE2: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 35.689500
                        },
                        LONGITUDE2: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 139.692000
                        }
                    }
                },
                {
                    opcode: 'getNorthLatitude',
                    blockType: BlockType.REPORTER,
                    text: '表示中の地図の北端の緯度',
                    arguments: {}
                },
                {
                    opcode: 'getSouthLatitude',
                    blockType: BlockType.REPORTER,
                    text: '表示中の地図の南端の緯度',
                    arguments: {}
                },
                {
                    opcode: 'getEastLongitude',
                    blockType: BlockType.REPORTER,
                    text: '表示中の地図の東端の経度',
                    arguments: {}
                },
                {
                    opcode: 'getWestLongitude',
                    blockType: BlockType.REPORTER,
                    text: '表示中の地図の西端の経度',
                    arguments: {}
                },
                {
                    opcode: 'getLatitudeFromCoordinates',
                    blockType: BlockType.REPORTER,
                    text: 'x座標 [X] y座標 [Y] の場所の緯度',
                    arguments: {
                        X: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        },
                        Y: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        }
                    }
                },
                {
                    opcode: 'getLongitudeFromCoordinates',
                    blockType: BlockType.REPORTER,
                    text: 'x座標 [X] y座標 [Y] の場所の経度',
                    arguments: {
                        X: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        },
                        Y: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        }
                    }
                },
                {
                    opcode: 'getXFromCoordinates',
                    blockType: BlockType.REPORTER,
                    text: '緯度 [LATITUDE] 経度 [LONGITUDE] の場所のx座標',
                    arguments: {
                        LATITUDE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 35.3251096
                        },
                        LONGITUDE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 139.558511
                        }
                    }
                },
                {
                    opcode: 'getYFromCoordinates',
                    blockType: BlockType.REPORTER,
                    text: '緯度 [LATITUDE] 経度 [LONGITUDE] の場所のy座標',
                    arguments: {
                        LATITUDE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 35.3251096
                        },
                        LONGITUDE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 139.558511
                        }
                    }
                }
            ],
            menus: {
                directions: {
                    acceptReporters: true,
                    items: ['上', '下', '左', '右']
                }
            }
        };
    }
}

module.exports = Scratch3OpenStreetMapBlocks;
