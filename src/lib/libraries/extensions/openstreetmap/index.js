const ArgumentType = require('scratch-vm/src/extension-support/argument-type');
const BlockType = require('scratch-vm/src/extension-support/block-type');
const Cast = require('scratch-vm/src/util/cast');
const StageLayering = require('scratch-vm/src/engine/stage-layering');
const TileMap = require('./tile-map');
const TileCache = require('./tile-cache');

/**
 * Class for the new blocks in Scratch 3.0
 * @param {Runtime} runtime - the runtime instantiating this block package.
 * @constructor
 */

// 簡易 Timer クラスを追加
class Timer {
    constructor() {
        this.startTime = 0;
    }

    start() {
        this.startTime = Date.now();
    }

    timeElapsed() {
        return Date.now() - this.startTime;
    }
}

/**
 * より正確な移動速度の実装
 */
class PreciseMovementController {
    constructor() {
        this.startTime = 0;
        this.lastUpdateTime = 0;
        this.lastPosition = { x: 0, y: 0 };
        this.targetSpeed = 0;
        this.accumulatedError = 0;
        this.isMoving = false;
        this.updateInterval = 33.33; // 更新間隔（ミリ秒）
    }

    /**
     * 移動を開始
     * @param {number} startX 開始X座標
     * @param {number} startY 開始Y座標
     * @param {number} speed 目標速度（メートル/秒）
     */
    startMovement(startX, startY, speed) {
        const now = Date.now();
        this.startTime = now;
        this.lastUpdateTime = now;
        this.lastPosition = { x: startX, y: startY };
        this.targetSpeed = speed;
        this.accumulatedError = 0;
        this.isMoving = true;
    }

    /**
     * 次の目標地点を計算
     * @param {number} currentX 現在のX座標
     * @param {number} currentY 現在のY座標
     * @param {number} targetX 最終目標のX座標
     * @param {number} targetY 最終目標のY座標
     * @param {number} stepDistance このステップでの移動距離
     * @returns {Object} 次の目標地点の座標
     */
    calculateNextTarget(currentX, currentY, targetX, targetY, stepDistance) {
        // 現在位置から最終目標までの距離と方向を計算
        const dx = targetX - currentX;
        const dy = targetY - currentY;
        const totalDistance = Math.sqrt(dx * dx + dy * dy);

        // 最終目標まで十分近い場合は最終目標をそのまま返す
        if (totalDistance <= stepDistance) {
            return { x: targetX, y: targetY };
        }

        // 単位ベクトルを計算
        const directionX = dx / totalDistance;
        const directionY = dy / totalDistance;

        // 次の目標地点を計算
        return {
            x: currentX + directionX * stepDistance,
            y: currentY + directionY * stepDistance
        };
    }

    /**
     * 1フレームの移動を処理
     * @param {Object} sprite スプライト
     * @param {number} finalTargetX 最終目標X座標
     * @param {number} finalTargetY 最終目標Y座標
     * @param {number} speed 速度（メートル/秒）
     * @param {number} timeScale 時間スケール
     * @param {number} metersPerPixel メートル/ピクセル比率
     * @returns {boolean} 移動が完了したかどうか
     */
    updateMovement(sprite, finalTargetX, finalTargetY, speed, timeScale, metersPerPixel) {
        // 移動が開始されていない場合は何もしない（外部で開始処理を行う）
        if (!this.isMoving) {
            return false;
        }

        const currentTime = Date.now();
        const deltaTime = currentTime - this.lastUpdateTime;

        // 更新間隔に達していない場合は処理をスキップ
        if (deltaTime < this.updateInterval) {
            return false;
        }

        // 目標地点までの残り距離を計算
        const dx = finalTargetX - sprite.x;
        const dy = finalTargetY - sprite.y;
        const remainingPixels = Math.sqrt(dx * dx + dy * dy);
        const remainingMeters = remainingPixels * metersPerPixel;

        // 移動完了判定
        if (remainingMeters < 0.01) {
            sprite.setXY(finalTargetX, finalTargetY);
            this.isMoving = false;
            return true;
        }

        // このステップでの移動距離を計算（ピクセル単位）
        const timeElapsedSeconds = deltaTime / 1000;
        const distanceToMoveMeters = speed * timeScale * timeElapsedSeconds;
        const distanceToMovePixels = distanceToMoveMeters / metersPerPixel;

        // 次の目標地点を計算
        const nextTarget = this.calculateNextTarget(
            sprite.x,
            sprite.y,
            finalTargetX,
            finalTargetY,
            distanceToMovePixels + this.accumulatedError
        );

        // 実際の移動距離を計算と誤差の蓄積
        const actualDx = nextTarget.x - sprite.x;
        const actualDy = nextTarget.y - sprite.y;
        const actualDistance = Math.sqrt(actualDx * actualDx + actualDy * actualDy);
        const intendedDistance = distanceToMovePixels;
        this.accumulatedError = intendedDistance - actualDistance;

        // スプライトの位置を更新
        sprite.setXY(nextTarget.x, nextTarget.y);
        
        // タイムスタンプを更新
        this.lastUpdateTime = currentTime;
        this.lastPosition = { x: nextTarget.x, y: nextTarget.y };

        return false;
    }

    /**
     * 現在の移動速度を取得（メートル/秒）
     */
    getCurrentSpeed(metersPerPixel) {
        if (!this.isMoving) return 0;
        
        const currentTime = Date.now();
        const deltaTime = (currentTime - this.startTime) / 1000;
        if (deltaTime === 0) return 0;

        const dx = this.lastPosition.x - this.lastPosition.x;
        const dy = this.lastPosition.y - this.lastPosition.y;
        const distancePixels = Math.sqrt(dx * dx + dy * dy);
        const distanceMeters = distancePixels * metersPerPixel;

        return distanceMeters / deltaTime;
    }
}
/**
 * 最短経路移動専用のコントローラー
 */
class PathMovementController {
    constructor() {
        this.isMoving = false;
        this.pathNodes = [];
        this.currentTargetIndex = 0;
        this.preciseMover = new PreciseMovementController();
    }

    /**
     * 経路移動を開始
     * @param {Array} pathNodeCoordinates ノードの座標配列 [{x, y}, ...]
     * @param {number} speed 移動速度（メートル/秒）
     */
    startPathMovement(pathNodeCoordinates, speed) {
        if (pathNodeCoordinates.length === 0) return false;
        
        this.pathNodes = [...pathNodeCoordinates];
        this.currentTargetIndex = 0;
        this.isMoving = true;
        
        console.log('経路移動開始:', { 
            totalNodes: this.pathNodes.length, 
            speed: speed,
            firstTarget: this.pathNodes[0] 
        });
        
        return true;
    }

    /**
     * 経路移動の更新処理
     * @param {Object} sprite スプライト
     * @param {number} speed 移動速度
     * @param {number} timeScale 時間スケール
     * @param {number} metersPerPixel メートル/ピクセル比率
     * @returns {boolean} 経路移動が完了したかどうか
     */
    updatePathMovement(sprite, speed, timeScale, metersPerPixel) {
        if (!this.isMoving || this.currentTargetIndex >= this.pathNodes.length) {
            return true; // 移動完了
        }

        const currentTarget = this.pathNodes[this.currentTargetIndex];
        
        // 現在のノードへの移動が開始されていない場合は開始
        if (!this.preciseMover.isMoving) {
            this.preciseMover.startMovement(sprite.x, sprite.y, speed);
            console.log(`ノード ${this.currentTargetIndex + 1}/${this.pathNodes.length} への移動開始:`, currentTarget);
        }

        // 現在のノードへの移動を実行
        const reachedCurrentTarget = this.preciseMover.updateMovement(
            sprite,
            currentTarget.x,
            currentTarget.y,
            speed,
            timeScale,
            metersPerPixel
        );

        if (reachedCurrentTarget) {
            console.log(`ノード ${this.currentTargetIndex + 1} に到達`);
            this.currentTargetIndex++;
            
            // 次のノードがある場合は移動を継続
            if (this.currentTargetIndex < this.pathNodes.length) {
                this.preciseMover = new PreciseMovementController(); // リセット
                return false; // まだ移動中
            } else {
                console.log('全ての経路移動が完了');
                this.isMoving = false;
                return true; // 全経路完了
            }
        }

        return false; // まだ移動中
    }

    /**
     * 移動をリセット
     */
    reset() {
        this.isMoving = false;
        this.pathNodes = [];
        this.currentTargetIndex = 0;
        this.preciseMover = new PreciseMovementController();
    }
}
/**
 * A*アルゴリズムによる最短経路探索
 */
class AStarPathfinder {
    constructor() {
        this.nodes = new Map();
        this.links = new Map();
    }

    /**
     * ノードデータを設定
     * @param {Array} nodeList - [NodeID, NodeX, NodeY] の配列
     */
    setNodes(nodeList) {
        this.nodes.clear();
        nodeList.forEach(([id, x, y]) => {
            this.nodes.set(id, { id, x, y });
        });
    }

    /**
     * リンクデータを設定
     * @param {Array} linkList - [LinkFrom, ToLink, LinkDistance] の配列
     */
    setLinks(linkList) {
        this.links.clear();
        linkList.forEach(([from, to, distance]) => {
            if (!this.links.has(from)) {
                this.links.set(from, []);
            }
            this.links.get(from).push({ to, distance });
            // 双方向リンクとして追加
        if (!this.links.has(to)) {
            this.links.set(to, []);
        }
        this.links.get(to).push({ to: from, distance });
        });
        
    }

    /**
     * ユークリッド距離によるヒューリスティック関数
     */
    heuristic(nodeA, nodeB) {
        const dx = nodeA.x - nodeB.x;
        const dy = nodeA.y - nodeB.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * A*アルゴリズムで最短経路を探索
     * @param {string|number} startId - 開始ノードID
     * @param {string|number} goalId - 目標ノードID
     * @returns {Array} - パスのノードID配列
     */
    findPath(startId, goalId) {
        const startNode = this.nodes.get(startId);
        const goalNode = this.nodes.get(goalId);

        if (!startNode || !goalNode) {
            console.error('Start or goal node not found');
            return [];
        }

        if (startId === goalId) {
            return [startId];
        }

        const openSet = new Set([startId]);
        const cameFrom = new Map();
        const gScore = new Map();
        const fScore = new Map();

        // 初期化
        this.nodes.forEach((node, id) => {
            gScore.set(id, Infinity);
            fScore.set(id, Infinity);
        });

        gScore.set(startId, 0);
        fScore.set(startId, this.heuristic(startNode, goalNode));

        while (openSet.size > 0) {
            // fScoreが最小のノードを選択
            let current = null;
            let minFScore = Infinity;
            for (const nodeId of openSet) {
                const score = fScore.get(nodeId);
                if (score < minFScore) {
                    minFScore = score;
                    current = nodeId;
                }
            }

            if (current === goalId) {
                // パスを再構築
                return this.reconstructPath(cameFrom, current);
            }

            openSet.delete(current);
            const currentNode = this.nodes.get(current);
            const neighbors = this.links.get(current) || [];

            for (const neighbor of neighbors) {
                const neighborId = neighbor.to;
                const tentativeGScore = gScore.get(current) + neighbor.distance;

                if (tentativeGScore < gScore.get(neighborId)) {
                    cameFrom.set(neighborId, current);
                    gScore.set(neighborId, tentativeGScore);
                    const neighborNode = this.nodes.get(neighborId);
                    fScore.set(neighborId, tentativeGScore + this.heuristic(neighborNode, goalNode));

                    openSet.add(neighborId);
                }
            }
        }

        // パスが見つからない場合
        return [];
    }

    /**
     * パスを再構築
     */
    reconstructPath(cameFrom, current) {
        const path = [current];
        while (cameFrom.has(current)) {
            current = cameFrom.get(current);
            path.unshift(current);
        }
        return path;
    }
}

/**
 * Scratch 3.0 の地図拡張機能
 */
class Scratch3OpenStreetMapBlocks {
    constructor(runtime) {
        this.runtime = runtime;
        this.tileMap = new TileMap();　// 地図タイル管理
        this.tileCache = new TileCache();　// タイルのキャッシュ管理
        
        // 時間と速度の設定（まとめる）
        this.timeScale = 1.0;                   // 時間の進行速度（1.0が標準）
        this.preciseMovements = new Map();      // スプライトごとの移動コントローラを管理
        this.simulationStartTime = Date.now();　// シミュレーション開始時間
        this.realStartTime = Date.now();　      // 実時間の開始時間
        this.isSimulationRunning = false;       // 初期状態はfalse
        this.baseSpeedPerMinute = 300;          // 基本移動速度（メートル/分）
        this.distanceScale = 1.0;               // 距離のスケール
        // この行を追加
        this.pathfinder = new AStarPathfinder();
        
        // 描画用キャンバスの設定
        this.canvas = document.createElement('canvas');
        this.canvas.width = 840;
        this.canvas.height = 540;
        
        // 地図の初期位置を東京に設定
        this.tileMap.centerLatitude = 35.689185;    // 東京の緯度
        this.tileMap.centerLongitude = 139.691648;  // 東京の経度
        this.tileMap.currentZoom = 18;              // 初期ズームレベル
        // 6/23追加
        this.setupXYMoveListener();

        // イベントリスナーの設定
        this.runtime.on('PROJECT_START', () => {
            console.log('Project started');  // デバッグログ
            this.isSimulationRunning = true;
            this.resetSimulationTime();
            // 初期地図の描画
            this.drawTileMap({
                LATITUDE: this.tileMap.centerLatitude,
                LONGITUDE: this.tileMap.centerLongitude,
                ZOOM: this.tileMap.currentZoom
            }).catch(error => {
                console.error('Initial map drawing failed:', error);
            });
        });

        // プロジェクト停止時の処理
        this.runtime.on('PROJECT_STOP_ALL', () => {
            console.log('Project stopped');  // デバッグログ
            this.isSimulationRunning = false;
            // 全ての移動コントローラをクリア
            this.preciseMovements.clear();
        });
    }

    // シミュレーション時間のリセット関数を追加
    resetSimulationTime() {
        const now = Date.now();
        this.simulationStartTime = now;
        this.realStartTime = now;
    }

    updateBlockDefaults(latitude, longitude) {
        const blocks = this.getInfo().blocks;
    
        console.log('Updating block defaults. Latitude:', latitude, 'Longitude:', longitude);
    
        blocks.forEach(block => {
            if (block.arguments?.LATITUDE) {
                block.arguments.LATITUDE.defaultValue = Number(latitude.toFixed(6));
                console.log('Updated LATITUDE default value:', block.arguments.LATITUDE.defaultValue);
            }
            if (block.arguments?.LONGITUDE) {
                block.arguments.LONGITUDE.defaultValue = Number(longitude.toFixed(6));
                console.log('Updated LONGITUDE default value:', block.arguments.LONGITUDE.defaultValue);
            }
        });
    
        if (this.runtime.extensionManager) {
            this.runtime.extensionManager.refreshBlocks();
            console.log('Block palette refreshed.');
        } else {
            console.error('ExtensionManager not found. Failed to refresh blocks.');
        }
    }  

    setupSpriteMoveListener() {
        this.runtime.on('TARGET_MOVED', target => {
            if (target.isStage) return; // ステージの移動は無視
    
            const latitude = this.getScratchCoordinateLatitude(target.x, target.y);
            const longitude = this.getScratchCoordinateLongitude(target.x, target.y);
            // 緯度・経度をブロックデフォルト値に反映
            this.updateBlockDefaults(latitude, longitude);
        });
    }
    setupSpriteMoveListener() {
        this.runtime.on('TARGET_MOVED', target => {
            if (target.isStage) return; // ステージの移動は無視
    
            const latitude = this.getScratchCoordinateLatitude(target.x, target.y);
            const longitude = this.getScratchCoordinateLongitude(target.x, target.y);
            // 緯度・経度をブロックデフォルト値に反映
            this.updateBlockDefaults(latitude, longitude);
        });
    } 

    // ↓↓↓ ここに追加 ↓↓↓
    setupXYMoveListener() {
        this.runtime.on('TARGET_MOVED', target => {
            if (target.isStage) return; // ステージの移動は無視

            // X、Y座標をブロックデフォルト値に反映
            this.updateXYBlockDefaults(target.x, target.y);
        });
    }

    updateXYBlockDefaults(x, y) {
        const blocks = this.getInfo().blocks;

        blocks.forEach(block => {
            // moveToXYWithPixelSpeedブロックのX、Y座標を更新
            if (block.opcode === 'moveToXYWithPixelSpeed') {
                if (block.arguments?.X) {
                    block.arguments.X.defaultValue = Number(x.toFixed(2));
                }
                if (block.arguments?.Y) {
                    block.arguments.Y.defaultValue = Number(y.toFixed(2));
                }
            }
        });

        // ブロックパレットを更新
        if (this.runtime.extensionManager) {
            this.runtime.extensionManager.refreshBlocks();
        }
    }
    // ↑↑↑ ここに追加 ↑↑↑

    getDistanceScale(args, util) {
        try {
            const metersPerPixel = this.getMetersPerPixel(
                this.tileMap.centerLatitude,
                this.tileMap.currentZoom
            );
            return Number(metersPerPixel.toFixed(4));
        } catch (error) {
            console.error('Scale calculation error:', error);
            return 0;
        }
    }

    /**
     * 緯度経度から距離を計算（ヒュベニの公式使用）
     */
    calculateDistance(lat1, lon1, lat2, lon2) {
        try {
            // 緯度経度をラジアンに変換
            const radLat1 = (Math.PI * lat1) / 180;
            const radLon1 = (Math.PI * lon1) / 180;
            const radLat2 = (Math.PI * lat2) / 180;
            const radLon2 = (Math.PI * lon2) / 180;

            // 緯度差、経度差
            const latDiff = radLat2 - radLat1;
            const lonDiff = radLon2 - radLon1;

            // 地球の扁平率と赤道半径
            const e2 = 0.00669438;
            const a = 6378137;

            // 平均緯度
            const avgLat = (radLat1 + radLat2) / 2;

            // 子午線曲率半径
            const sinLat = Math.sin(avgLat);
            const W = Math.sqrt(1 - e2 * sinLat * sinLat);
            const M = a * (1 - e2) / (W * W * W);

            // 卯酉線曲率半径
            const N = a / W;

            // 2点間の距離を計算
            const distance = Math.sqrt(
                Math.pow(M * latDiff, 2) +
                Math.pow(N * Math.cos(avgLat) * lonDiff, 2)
            );

            return distance;
        } catch (error) {
            console.error('Distance calculation error:', error);
            return 0;
        }
    }  

    /**
     * 2地点間の距離を計算
     */
    calculateDistanceBetweenPoints(args) {
        try {
            const lat1 = Cast.toNumber(args.LATITUDE1);
            const lon1 = Cast.toNumber(args.LONGITUDE1);
            const lat2 = Cast.toNumber(args.LATITUDE2);
            const lon2 = Cast.toNumber(args.LONGITUDE2);

            const distance = this.calculateDistance(lat1, lon1, lat2, lon2);
            return Math.round(distance);
        } catch (error) {
            console.error('Distance between points calculation error:', error);
            return 0;
        }
    }      

    // 東西南北取得
    getMapBounds() {
        try {
            const zoom = this.tileMap.currentZoom;
            const worldWidth = 256 * Math.pow(2, zoom);
            const canvasWidth = this.canvas.width;
            const canvasHeight = this.canvas.height;

            // 地図の四隅のScratch座標を計算
            const corners = {
                northWest: { x: -canvasWidth/2, y: canvasHeight/2 },
                northEast: { x: canvasWidth/2, y: canvasHeight/2 },
                southWest: { x: -canvasWidth/2, y: -canvasHeight/2 },
                southEast: { x: canvasWidth/2, y: -canvasHeight/2 }
            };

            // 各コーナーの緯度経度を計算
            const bounds = {};
            for (const [corner, coords] of Object.entries(corners)) {
                const location = this.getScratchCoordinateLocation(coords.x, coords.y);
                if (!location) continue;

                const [pos1, pos2] = corner.split(/(?=[A-Z])/); // 'northWest' -> ['north', 'West']
                if (!bounds[pos1.toLowerCase()]) bounds[pos1.toLowerCase()] = location.latitude;
                if (!bounds[pos2.toLowerCase()]) bounds[pos2.toLowerCase()] = location.longitude;

                // 最大値・最小値の更新
                bounds[pos1.toLowerCase()] = pos1 === 'north' ? 
                    Math.max(bounds[pos1.toLowerCase()], location.latitude) :
                    Math.min(bounds[pos1.toLowerCase()], location.latitude);
                
                bounds[pos2.toLowerCase()] = pos2 === 'east' ? 
                    Math.max(bounds[pos2.toLowerCase()], location.longitude) :
                    Math.min(bounds[pos2.toLowerCase()], location.longitude);
            }

            return bounds;
        } catch (error) {
            console.error('Map bounds calculation error:', error);
            return null;
        }
    }

    moveToCoordinateWithSpeed(args, util) {
        const targetLatitude = Cast.toNumber(args.LATITUDE);
        const targetLongitude = Cast.toNumber(args.LONGITUDE);
        const speedMeterPerSecond = Cast.toNumber(args.SPEED);

        try {
            // スプライト固有の移動コントローラを取得または作成
            if (!this.preciseMovements.has(util.target.id)) {
                this.preciseMovements.set(util.target.id, new PreciseMovementController());
            }
            const movement = this.preciseMovements.get(util.target.id);

            // 目標座標をスクラッチ座標に変換
            const targetCoords = this.convertLatLngToScratch(targetLatitude, targetLongitude);

            // メートル/ピクセル変換スケールを取得
            const currentLatitude = this.getScratchCoordinateLatitude(util.target.x, util.target.y);
            const metersPerPixel = this.getMetersPerPixel(currentLatitude, this.tileMap.currentZoom);

            // 移動が開始されていない場合、現在位置から開始
            if (!movement.isMoving) {
                movement.startMovement(util.target.x, util.target.y, speedMeterPerSecond);
            }

            // 移動処理を実行
            const isComplete = movement.updateMovement(
                util.target,
                targetCoords.x,
                targetCoords.y,
                speedMeterPerSecond,
                this.timeScale,
                metersPerPixel
            );

            if (!isComplete) {
                // まだ移動中なのでyieldする
                util.yield();
            } else {
                // 移動完了したのでコントローラを削除
                this.preciseMovements.delete(util.target.id);
            }
        } catch (error) {
            console.error('Error in moveToCoordinateWithSpeed:', error);
            // エラー時もコントローラを削除
            this.preciseMovements.delete(util.target.id);
        }
    }

    /**
     * Scratch座標を緯度・経度に変換。
     * @param {number} scratchX - Scratchのx座標。
     * @param {number} scratchY - Scratchのy座標。
     * @returns {Object} 緯度と経度。
     */
    getScratchCoordinateLocation(scratchX, scratchY) {
        const zoom = this.tileMap.currentZoom;
        const worldWidth = 256 * Math.pow(2, zoom);

        const centerPixelX = ((this.tileMap.centerLongitude + 180) / 360) * worldWidth;
        const centerPixelY =
            (0.5 -
                Math.log(
                    (1 + Math.sin((this.tileMap.centerLatitude * Math.PI) / 180)) /
                        (1 - Math.sin((this.tileMap.centerLatitude * Math.PI) / 180))
                ) /
                    (4 * Math.PI)) *
            worldWidth;

        const targetPixelX = centerPixelX + scratchX;
        const targetPixelY = centerPixelY - scratchY;

        const longitude = (targetPixelX / worldWidth) * 360 - 180;
        const latitudeRad = Math.PI * (1 - 2 * (targetPixelY / worldWidth));
        const latitude = (Math.atan(Math.sinh(latitudeRad)) * 180) / Math.PI;

        return {
            latitude: Number(latitude.toFixed(6)),
            longitude: Number(longitude.toFixed(6)),
        };
    }

    // Helper method for coordinate conversion
    _normalizeCoordinate(value) {
        if (!value) throw new Error('Invalid coordinate');
        return typeof value === 'function' ? Number(value()) : Number(String(value));
    }

    // シミュレーション時間を取得（ミリ秒）
    getSimulationTime() {
        const realElapsed = Date.now() - this.realStartTime;
        return this.simulationStartTime + (realElapsed * this.timeScale);
    }

    // シミュレーション時間のスケールを設定
    setTimeScale(args) {
        const newScale = Cast.toNumber(args.SCALE);
        if (newScale > 0) {
            // 現在のシミュレーション時間を保存
            const currentSimTime = this.getSimulationTime();
            
            // タイムスケールを更新
            this.timeScale = newScale;
            
            // 開始時間を調整して連続性を保つ
            this.realStartTime = Date.now();
            this.simulationStartTime = currentSimTime;
        }
    }

    // 現在のシミュレーション時間を取得（秒）
    getCurrentSimulationTime() {
        return Math.floor((this.getSimulationTime() - this.simulationStartTime) / 1000);
    }

    /**
     * 住所を国土地理院APIでジオコーディングし、地図を表示
     * @param {Object} args - Scratchのブロック引数。
     */
    async addressSearchAndDisplay(args) {
        const address = Cast.toString(args.ADDRESS);
        const zoom = Math.floor(Cast.toNumber(args.ZOOM));

        try {
            // 国土地理院の位置参照情報APIを使用して住所をジオコーディング
            const response = await fetch(
                `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(address)}`
            );
            const results = await response.json();

            if (results.length > 0) {
                const location = results[0];
                const latitude = parseFloat(location.geometry.coordinates[1]); // 緯度
                const longitude = parseFloat(location.geometry.coordinates[0]); // 経度

                // 地図の中心を検索結果の緯度・経度に設定
                this.tileMap.centerLatitude = latitude;
                this.tileMap.centerLongitude = longitude;
                this.tileMap.currentZoom = zoom;

                // 地図を描画
                await this.drawTileMap({
                    LATITUDE: latitude,
                    LONGITUDE: longitude,
                    ZOOM: zoom
                });
            } else {
                console.error('住所検索結果が見つかりません');
            }
        } catch (error) {
            console.error('ジオコーディングエラー:', error);
        }
    }

    /**
     * 地図タイルを描画
     * @param {Object} args - Scratchのブロック引数。
     */
    async drawTileMap(args) {
        const latitude = Cast.toNumber(args.LATITUDE);
        const longitude = Cast.toNumber(args.LONGITUDE);
        const zoom = Math.floor(Cast.toNumber(args.ZOOM));

        Object.assign(this.tileMap, {
            centerLatitude: latitude,
            centerLongitude: longitude,
            currentZoom: zoom
        });

        this.tileMap.buildTiles(zoom, longitude, latitude, this.canvas.width, this.canvas.height);
        await this.drawTileImages();
    }

    async drawTileImages() {
        if (!this.runtime.renderer) return;

        const ctx = this.canvas.getContext('2d');
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

         // 彩度を適度に向上させるフィルターを適用（白飛びを避ける）
        ctx.filter = 'saturate(1.2) contrast(1.05)';

        // 並列でタイル画像を取得
        const imagePromises = this.tileMap.tiles.map(tile =>
            this.tileCache.getImage(tile.zoom, tile.x, tile.y)
        );

        try {
            const images = await Promise.all(imagePromises);

            // バッチで描画（フィルター適用済み）
            images.forEach((image, i) => {
                if (image && image.complete) {
                    const tile = this.tileMap.tiles[i];
                    ctx.drawImage(image, tile.screenX, tile.screenY);
                }
            });

            // フィルターをリセット
            ctx.filter = 'none';

            // Scratchレンダラーに送信
            const skinId = this.runtime.renderer.createBitmapSkin(this.canvas, 1);
            const drawableId = this.runtime.renderer.createDrawable(StageLayering.BACKGROUND_LAYER);
            this.runtime.renderer.updateDrawableProperties(drawableId, { skinId });

        } catch (error) {
            console.error('Tile drawing error:', error);
            // エラー時もフィルターをリセット
            ctx.filter = 'none';
        }
    }

    async getElevation(args, util) {
        try {
            // 緯度経度を取得
            let latitude, longitude;
            
            if (args.COORDINATES) {
                // 文字列から緯度経度を抽出
                const match = args.COORDINATES.match(/緯度:\s*([\d.-]+),\s*経度:\s*([\d.-]+)/);
                if (match) {
                    latitude = parseFloat(match[1]);
                    longitude = parseFloat(match[2]);
                } else {
                    return '無効な座標形式です';
                }
            } else if (args.LATITUDE && args.LONGITUDE) {
                // 様々な入力形式に対応
                // 直接関数呼び出しや、数値、文字列を想定
                latitude = this._normalizeCoordinate(args.LATITUDE);
                longitude = this._normalizeCoordinate(args.LONGITUDE);
            } else {
                return 'エラー: 緯度経度が指定されていません';
            }
    
            // 範囲チェック
            if (isNaN(latitude) || isNaN(longitude) ||
                latitude < -90 || latitude > 90 ||
                longitude < -180 || longitude > 180) {
                return '範囲外: 無効な座標です';
            }
    
            // 国土地理院APIのURL構築
            const apiUrl = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${longitude}&lat=${latitude}&outtype=JSON`;
    
            // APIリクエスト
            const response = await fetch(apiUrl);
            const data = await response.json();
    
            // 結果の処理
            if (data && typeof data.elevation === 'number') {
                // 標高を小数点第一位まで表示
                const elevation = Number(data.elevation.toFixed(1));
                return `${elevation}`;
            } else if (data && data.elevation === null) {
                return '標高データなし';
            } else {
                return 'エラー: 標高の取得に失敗しました';
            }
    
        } catch (error) {
            console.error('Error fetching elevation:', error);
            return 'エラー: 標高の取得に失敗しました';
        }
    }

    moveMap(args) {
        const direction = args.DIRECTION.toLowerCase();
        const step = 0.0001; // 移動ステップ（調整可能）

        if (direction === '上') {
            this.tileMap.centerLatitude += step;
        } else if (direction === '下') {
            this.tileMap.centerLatitude -= step;
        } else if (direction === '左') {
            this.tileMap.centerLongitude -= step;
        } else if (direction === '右') {
            this.tileMap.centerLongitude += step;
        }

        // 地図を再描画
        this.tileMap.buildTiles(this.tileMap.currentZoom, this.tileMap.centerLongitude, this.tileMap.centerLatitude, 840, 540);
        this.drawTileImages();
    }

    /**
     * 緯度・経度からScratch座標に変換する関数
     */
    convertLatLngToScratch(latitude, longitude) {
        const zoom = this.tileMap.currentZoom; // 現在のズームレベル
        const worldWidth = 256 * Math.pow(2, zoom); // 世界の幅（ピクセル単位）

        // 地図の中心をピクセル座標に変換
        const centerPixelX = ((this.tileMap.centerLongitude + 180) / 360) * worldWidth;
        const centerSinLatitude = Math.sin((this.tileMap.centerLatitude * Math.PI) / 180);
        const centerPixelY =
            (0.5 - Math.log((1 + centerSinLatitude) / (1 - centerSinLatitude)) / (4 * Math.PI)) *
            worldWidth;

        // 対象の緯度経度をピクセル座標に変換
        const targetPixelX = ((longitude + 180) / 360) * worldWidth;
        const targetSinLatitude = Math.sin((latitude * Math.PI) / 180);
        const targetPixelY =
            (0.5 - Math.log((1 + targetSinLatitude) / (1 - targetSinLatitude)) / (4 * Math.PI)) *
            worldWidth;

        // 中心との相対座標を計算
        const scratchX = targetPixelX - centerPixelX;
        const scratchY = centerPixelY - targetPixelY;

        return {
            x: scratchX,
            y: scratchY
        };
    }

    getMonitored() {
        return {
            // スプライトの緯度を監視
            sprite_latitude: {
                isSpriteSpecific: true,
                getId: targetId => `${targetId}_latitude`,
                get: (target) => {
                    const spriteX = target.x;
                    const spriteY = target.y;
                    return this.getScratchCoordinateLatitude(spriteX, spriteY);
                }
            },
            // スプライトの経度を監視
            sprite_longitude: {
                isSpriteSpecific: true,
                getId: targetId => `${targetId}_longitude`,
                get: (target) => {
                    const spriteX = target.x;
                    const spriteY = target.y;
                    return this.getScratchCoordinateLongitude(spriteX, spriteY);
                }
            }
        };
    }

    /**
     * スプライトを指定された緯度・経度に移動させるブロックの実装
     */
    moveSpriteToCoordinates(args, util) {
        const latitude = Cast.toNumber(args.LATITUDE);
        const longitude = Cast.toNumber(args.LONGITUDE);

        // 緯度経度からScratch座標に変換
        const coordinates = this.convertLatLngToScratch(latitude, longitude);

        // スプライトの位置を設定
        util.target.setXY(coordinates.x, coordinates.y);
    }

    getCurrentLocation(args, util) {
        try {
            // スプライトの現在の座標を取得
            const spriteX = util.target.x;
            const spriteY = util.target.y;
    
            // 座標から緯度経度を計算
            const location = this.getScratchCoordinateLocation(spriteX, spriteY);
    
            if (location) {
                return `緯度: ${location.latitude}, 経度: ${location.longitude}`;
            } else {
                return '座標取得エラー';
            }
        } catch (error) {
            console.error('Current location retrieval error:', error);
            return '座標取得エラー';
        }
    }

    getScratchCoordinateLatitude(scratchX, scratchY) {
        try {
            const zoom = this.tileMap.currentZoom;
            const worldWidth = 256 * Math.pow(2, zoom);
    
            const centerPixelX = ((this.tileMap.centerLongitude + 180) / 360) * worldWidth;
            const centerSinLatitude = Math.sin((this.tileMap.centerLatitude * Math.PI) / 180);
            const centerPixelY =
                (0.5 - Math.log((1 + centerSinLatitude) / (1 - centerSinLatitude)) / (4 * Math.PI)) *
                worldWidth;
    
            const targetPixelX = centerPixelX + scratchX;
            const targetPixelY = centerPixelY - scratchY;
    
            const latitudeRad = Math.PI * (1 - 2 * (targetPixelY / worldWidth));
            const latitude = (Math.atan(Math.sinh(latitudeRad)) * 180) / Math.PI;
    
            return Number(latitude.toFixed(6));
        } catch (error) {
            console.error('Latitude retrieval error:', error);
            return 0;
        }
    }

    getScratchCoordinateLongitude(scratchX, scratchY) {
        try {
            const zoom = this.tileMap.currentZoom;
            const worldWidth = 256 * Math.pow(2, zoom);
    
            const centerPixelX = ((this.tileMap.centerLongitude + 180) / 360) * worldWidth;
            const centerSinLatitude = Math.sin((this.tileMap.centerLatitude * Math.PI) / 180);
            const centerPixelY =
                (0.5 - Math.log((1 + centerSinLatitude) / (1 - centerSinLatitude)) / (4 * Math.PI)) *
                worldWidth;
    
            const targetPixelX = centerPixelX + scratchX;
    
            const longitude = (targetPixelX / worldWidth) * 360 - 180;
   
            return Number(longitude.toFixed(6));
        } catch (error) {
            console.error('Longitude retrieval error:', error);
            return 0;
        }
    }

    getMetersPerPixel(latitude, zoom) {
        const EARTH_CIRCUMFERENCE = 40075016.686;
        const latitudeRadians = latitude * Math.PI / 180;
        return (EARTH_CIRCUMFERENCE * Math.cos(latitudeRadians)) / Math.pow(2, zoom + 8);
    }

    getCurrentLatitude(args, util) {
        try {
            const spriteX = util.target.x;
            const spriteY = util.target.y;
    
            return this.getScratchCoordinateLatitude(spriteX, spriteY);
        } catch (error) {
            console.error('Current latitude retrieval error:', error);
            return 0;
        }
    }

    getCurrentLongitude(args, util) {
        try {
            const spriteX = util.target.x;
            const spriteY = util.target.y;
    
            return this.getScratchCoordinateLongitude(spriteX, spriteY);
        } catch (error) {
            console.error('Current longitude retrieval error:', error);
            return 0;
        }
    }

    // Scratch3OpenStreetMapBlocksクラスのmoveStepWithSpeedTowardCoordinateメソッドを更新
    moveStepWithSpeedTowardCoordinate(args, util) {
        try {
            if (!this.preciseMovement) {
                this.preciseMovement = new PreciseMovementController();
            }

            // パラメータの取得
            const baseSpeedMS = Cast.toNumber(args.SPEED);
            const targetLatitude = Cast.toNumber(args.LATITUDE);
            const targetLongitude = Cast.toNumber(args.LONGITUDE);
            const timeScale = Cast.toNumber(args.TIMESCALE);

            // 目標座標をスクラッチ座標に変換
            const targetCoordinates = this.convertLatLngToScratch(targetLatitude, targetLongitude);

            // メートル/ピクセル変換スケールを取得
            const currentLatitude = this.getScratchCoordinateLatitude(util.target.x, util.target.y);
            const metersPerPixel = this.getMetersPerPixel(currentLatitude, this.tileMap.currentZoom);

            // 移動処理を実行
            const isComplete = this.preciseMovement.updateMovement(
                util.target,
                targetCoordinates.x,
                targetCoordinates.y,
                baseSpeedMS,
                timeScale,
                metersPerPixel
            );

            if (isComplete) {
                // 移動が完了したら状態をリセット
                this.preciseMovement = new PreciseMovementController();
            }

        } catch (error) {
            console.error('Error in precise moveStepWithSpeedTowardCoordinate:', error);
        }
    }
    convertScratchToMeters(args, util) {
        try {
            const scratchDistance = Cast.toNumber(args.DISTANCE);
            const meters = this.convertScratchDistanceToMeters(
                scratchDistance,
                this.tileMap.centerLatitude,
                this.tileMap.currentZoom
            );
            return Number(meters.toFixed(1));
        } catch (error) {
            console.error('Distance conversion error:', error);
            return 0;
        }
    }

    getNorthLatitude() {
        const bounds = this.getMapBounds();
        return bounds ? Number(bounds.north.toFixed(6)) : 0;
    }  

    getSouthLatitude() {
        const bounds = this.getMapBounds();
        return bounds ? Number(bounds.south.toFixed(6)) : 0;
    }

    getEastLongitude() {
        const bounds = this.getMapBounds();
        return bounds ? Number(bounds.east.toFixed(6)) : 0;
    }   

    getWestLongitude() {
        const bounds = this.getMapBounds();
        return bounds ? Number(bounds.west.toFixed(6)) : 0;
    }

    /**
     * 指定されたScratch座標(X,Y)の緯度を取得
     * @param {Object} args - ブロック引数
     * @returns {number} 緯度
     */
    getLatitudeFromCoordinates(args) {
        try {
            const scratchX = Cast.toNumber(args.X);
            const scratchY = Cast.toNumber(args.Y);
            
            return this.getScratchCoordinateLatitude(scratchX, scratchY);
        } catch (error) {
            console.error('Error getting latitude from coordinates:', error);
            return 0;
        }
    }

    /**
     * 指定されたScratch座標(X,Y)の経度を取得
     * @param {Object} args - ブロック引数
     * @returns {number} 経度
     */
    getLongitudeFromCoordinates(args) {
        try {
            const scratchX = Cast.toNumber(args.X);
            const scratchY = Cast.toNumber(args.Y);
            
            return this.getScratchCoordinateLongitude(scratchX, scratchY);
        } catch (error) {
            console.error('Error getting longitude from coordinates:', error);
            return 0;
        }
    }

    // 緯度経度をx座標に変換するメソッド
    getXFromCoordinates(args) {
        try {
            const latitude = Cast.toNumber(args.LATITUDE);
            const longitude = Cast.toNumber(args.LONGITUDE);
            
            const coordinates = this.convertLatLngToScratch(latitude, longitude);
            return Number(coordinates.x.toFixed(2));
        } catch (error) {
            console.error('Error getting X coordinate from lat/lon:', error);
            return 0;
        }
    }

    // 緯度経度をy座標に変換するメソッド
    getYFromCoordinates(args) {
        try {
            const latitude = Cast.toNumber(args.LATITUDE);
            const longitude = Cast.toNumber(args.LONGITUDE);
            
            const coordinates = this.convertLatLngToScratch(latitude, longitude);
            return Number(coordinates.y.toFixed(2));
        } catch (error) {
            console.error('Error getting Y coordinate from lat/lon:', error);
            return 0;
        }
    }

    // === Scratchデータ連携の最短経路探索機能 ===

    /**
     * フロントエンド（Scratch）の道路ネットワークデータを使用してA*最短経路探索を実行
     */
    findPathFromScratchData(args, util) {
        try {
            const startNodeId = Cast.toNumber(args.START_NODE_ID);
            const goalNodeId = Cast.toNumber(args.GOAL_NODE_ID);

            // Scratchの変数とリストを取得
            const stage = this.runtime.getTargetForStage();
            if (!stage) {
                return 'エラー: ステージが見つかりません';
            }

            // 表示範囲内のノードデータを取得
            const displayNodeIDs = this.getScratchList(stage, '表示NodeID');
            const displayNodeXs = this.getScratchList(stage, '表示NodeX');
            const displayNodeYs = this.getScratchList(stage, '表示NodeY');
            const displayLinkFroms = this.getScratchList(stage, '表示LinkFrom');
            const displayLinkTos = this.getScratchList(stage, '表示LinkTo');

            if (!displayNodeIDs || !displayNodeXs || !displayNodeYs || !displayLinkFroms || !displayLinkTos) {
                return 'エラー: 道路ネットワークデータが見つかりません';
            }

            // データの整合性チェック
            if (displayNodeIDs.length !== displayNodeXs.length || displayNodeIDs.length !== displayNodeYs.length) {
                return 'エラー: ノードデータの長さが一致しません';
            }

            if (displayLinkFroms.length !== displayLinkTos.length) {
                return 'エラー: リンクデータの長さが一致しません';
            }

            // ノードデータの準備
            const nodeArray = [];
            for (let i = 0; i < displayNodeIDs.length; i++) {
                nodeArray.push([
                    Number(displayNodeIDs[i]),
                    Number(displayNodeXs[i]),
                    Number(displayNodeYs[i])
                ]);
            }

            // リンクデータの準備（距離計算付き）
            const linkArray = [];
            for (let i = 0; i < displayLinkFroms.length; i++) {
                const fromNodeId = Number(displayLinkFroms[i]);
                const toNodeId = Number(displayLinkTos[i]);

                // ノード座標を検索
                const fromNode = nodeArray.find(node => node[0] === fromNodeId);
                const toNode = nodeArray.find(node => node[0] === toNodeId);

                if (fromNode && toNode) {
                    // ユークリッド距離を計算
                    const dx = toNode[1] - fromNode[1];
                    const dy = toNode[2] - fromNode[2];
                    const distance = Math.sqrt(dx * dx + dy * dy);

                    linkArray.push([fromNodeId, toNodeId, distance]);
                }
            }

            // A*パスファインダーにデータを設定
            this.pathfinder.setNodes(nodeArray);
            this.pathfinder.setLinks(linkArray);

            // 最短経路を探索
            const path = this.pathfinder.findPath(startNodeId, goalNodeId);

            if (path.length > 0) {
                // ← この行を追加
                this.addPathToList(stage, path);
                const result = path.join(',');
                
                // 結果をScratchの変数に保存
                this.setScratchVariable(stage, '経路探索結果', result);
                
                return result;
            } else {
                const errorMsg = 'パスが見つかりません';
                this.setScratchVariable(stage, '経路探索結果', errorMsg);
                return errorMsg;
            }

        } catch (error) {
            console.error('Path finding error:', error);
            const errorMsg = 'エラー: 経路探索に失敗しました';
            
            // エラーもScratchの変数に保存
            const stage = this.runtime.getTargetForStage();
            if (stage) {
                this.setScratchVariable(stage, '経路探索結果', errorMsg);
            }
            
            return errorMsg;
        }
    }

    /**
     * Scratchのリストデータを取得するヘルパー関数
     */
    getScratchList(target, listName) {
        try {
            const list = target.lookupVariableByNameAndType(listName, 'list');
            return list ? list.value : null;
        } catch (error) {
            console.error(`Error getting Scratch list ${listName}:`, error);
            return null;
        }
    }

    /**
     * Scratchの変数データを取得するヘルパー関数
     */
    getScratchVariable(target, variableName) {
        try {
            const variable = target.lookupVariableByNameAndType(variableName, '');
            return variable ? variable.value : null;
        } catch (error) {
            console.error(`Error getting Scratch variable ${variableName}:`, error);
            return null;
        }
    }

    /**
     * Scratchの変数にデータを設定するヘルパー関数
     */
    setScratchVariable(target, variableName, value) {
        try {
            const variable = target.lookupVariableByNameAndType(variableName, '');
            if (variable) {
                variable.value = value;
                return true;
            }
            return false;
        } catch (error) {
            console.error(`Error setting Scratch variable ${variableName}:`, error);
            return false;
        }
    }

    /**
     * パスの結果をScratchのリストに追加する
     */
    addPathToList(target, pathArray) {
        try {
            let pathList = target.lookupVariableByNameAndType('最短経路', 'list');
            
            if (!pathList) {
                // リストが存在しない場合は作成（簡易的なID生成）
                const listId = Math.random().toString(36).substr(2, 9);
                pathList = target.createVariable(listId, '最短経路', 'list');
            }
            
            pathList.value = [];
            pathArray.forEach(nodeId => {
                pathList.value.push(String(nodeId));
            });
            
            return true;
        } catch (error) {
            console.error('Error adding path to list:', error);
            return false;
        }
    }

    clearPathList(args, util) {
        try {
            const stage = this.runtime.getTargetForStage();
            if (!stage) return;
            
            const pathList = stage.lookupVariableByNameAndType('最短経路', 'list');
            if (pathList) {
                pathList.value = [];
            }
        } catch (error) {
            console.error('Error clearing path list:', error);
        }
    }
    /**
     * 最短経路を指定されたリストに追加するブロック
     */
    findPathToPathList(args, util) {
        try {
            const startNodeId = Cast.toNumber(args.START_NODE_ID);
            const goalNodeId = Cast.toNumber(args.GOAL_NODE_ID);
            const listName = 'Path'; // 既存のPathリストを使用
            
            console.log('経路探索開始:', { startNodeId, goalNodeId, listName });

            const stage = this.runtime.getTargetForStage();
            if (!stage) {
                console.error('ステージが見つかりません');
                return;
            }

            const targetList = stage.lookupVariableByNameAndType(listName, 'list');
            if (!targetList) {
                console.error(`リスト "${listName}" が見つかりません`);
                return;
            }

            // 表示範囲内のノードデータを取得
            const displayNodeIDs = this.getScratchList(stage, '表示NodeID');
            const displayNodeXs = this.getScratchList(stage, '表示NodeX');
            const displayNodeYs = this.getScratchList(stage, '表示NodeY');
            const displayLinkFroms = this.getScratchList(stage, '表示LinkFrom');
            const displayLinkTos = this.getScratchList(stage, '表示LinkTo');

            if (!displayNodeIDs || !displayNodeXs || !displayNodeYs || !displayLinkFroms || !displayLinkTos) {
                console.error('道路ネットワークデータが見つかりません');
                return;
            }

            // ノードデータの準備
            const nodeArray = [];
            for (let i = 0; i < displayNodeIDs.length; i++) {
                nodeArray.push([
                    Number(displayNodeIDs[i]),
                    Number(displayNodeXs[i]),
                    Number(displayNodeYs[i])
                ]);
            }

            // リンクデータの準備
            const linkArray = [];
            for (let i = 0; i < displayLinkFroms.length; i++) {
                const fromNodeId = Number(displayLinkFroms[i]);
                const toNodeId = Number(displayLinkTos[i]);

                const fromNode = nodeArray.find(node => node[0] === fromNodeId);
                const toNode = nodeArray.find(node => node[0] === toNodeId);

                if (fromNode && toNode) {
                    const dx = toNode[1] - fromNode[1];
                    const dy = toNode[2] - fromNode[2];
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    linkArray.push([fromNodeId, toNodeId, distance]);
                }
            }

            // A*パスファインダーにデータを設定
            this.pathfinder.setNodes(nodeArray);
            this.pathfinder.setLinks(linkArray);

            // 最短経路を探索
            const path = this.pathfinder.findPath(startNodeId, goalNodeId);

            if (path.length > 0) {
                // Pathリストをクリアして結果を追加
                targetList.value = [];
                path.forEach(nodeId => {
                    targetList.value.push(String(nodeId));
                });
                console.log(`${path.length}個のノードをPathリストに追加しました:`, path);
            } else {
                console.error('パスが見つかりません');
            }

        } catch (error) {
            console.error('Path finding to Path list error:', error);
        }
    }
    /**
     * 指定されたピクセル/秒の速度でx,y座標に移動
     */
    moveToXYWithPixelSpeed(args, util) {
        const targetX = Cast.toNumber(args.X);
        const targetY = Cast.toNumber(args.Y);
        const speedPixelsPerSecond = Cast.toNumber(args.SPEED);

        try {
            // スプライト固有の移動コントローラを取得または作成
            if (!this.preciseMovements.has(util.target.id)) {
                this.preciseMovements.set(util.target.id, new PreciseMovementController());
            }
            const movement = this.preciseMovements.get(util.target.id);

            // 移動が開始されていない場合、現在位置から開始
            if (!movement.isMoving) {
                movement.startMovement(util.target.x, util.target.y, speedPixelsPerSecond);
            }

            // ピクセル速度なので、メートル/ピクセル比率は1.0として扱う
            const metersPerPixel = 1.0;

            // 移動処理を実行
            const isComplete = movement.updateMovement(
                util.target,
                targetX,
                targetY,
                speedPixelsPerSecond,
                this.timeScale,
                metersPerPixel
            );

            if (!isComplete) {
                // まだ移動中なのでyieldする
                util.yield();
            } else {
                // 移動完了したのでコントローラを削除
                this.preciseMovements.delete(util.target.id);
            }
        } catch (error) {
            console.error('Error in moveToXYWithPixelSpeed:', error);
            // エラー時もコントローラを削除
            this.preciseMovements.delete(util.target.id);
        }
    }
    /**
 * 秒速〇m/sでx座標を〇、y座標を〇にするブロック
 */
    moveToXYWithMeterSpeed(args, util) {
        const targetX = Cast.toNumber(args.X);
        const targetY = Cast.toNumber(args.Y);
        const speedMetersPerSecond = Cast.toNumber(args.SPEED);

        try {
            // スプライト固有の移動コントローラを取得または作成
            if (!this.preciseMovements.has(util.target.id)) {
                this.preciseMovements.set(util.target.id, new PreciseMovementController());
            }
            const movement = this.preciseMovements.get(util.target.id);

            // 現在のスプライト位置から緯度を取得してメートル/ピクセル比率を計算
            const currentLatitude = this.getScratchCoordinateLatitude(util.target.x, util.target.y);
            const metersPerPixel = this.getMetersPerPixel(currentLatitude, this.tileMap.currentZoom);

            // 移動が開始されていない場合、現在位置から開始
            if (!movement.isMoving) {
                movement.startMovement(util.target.x, util.target.y, speedMetersPerSecond);
            }

            // 移動処理を実行（メートル/秒の速度で）
            const isComplete = movement.updateMovement(
                util.target,
                targetX,
                targetY,
                speedMetersPerSecond,
                this.timeScale,
                metersPerPixel
            );

            if (!isComplete) {
                // まだ移動中なのでyieldする
                util.yield();
            } else {
                // 移動完了したのでコントローラを削除
                this.preciseMovements.delete(util.target.id);
            }
        } catch (error) {
            console.error('Error in moveToXYWithMeterSpeed:', error);
            // エラー時もコントローラを削除
            this.preciseMovements.delete(util.target.id);
        }
    }
    /**
     * ブロック情報を取得。
     * @returns {Object} Scratchブロック定義。
     */
    getInfo() {
        return {
            id: 'openStreetMap',
            name: '追加ブロック',
            blocks: [
                {
                    opcode: 'moveToXYWithPixelSpeed',
                    blockType: BlockType.COMMAND,
                    text: '秒速 [SPEED] ピクセルでx座標を [X] 、y座標を [Y] にする',
                    arguments: {
                        SPEED: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 50
                        },
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
                    opcode: 'moveToXYWithMeterSpeed',
                    blockType: BlockType.COMMAND,
                    text: '秒速 [SPEED] m/sでx座標を [X] 、y座標を [Y] にする',
                    arguments: {
                        SPEED: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 1.0
                        },
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
                    opcode: 'moveSpriteToCoordinates',
                    text: '緯度を [LATITUDE] 、経度 を[LONGITUDE] にする',
                    blockType: BlockType.COMMAND,
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
                    opcode: 'addressSearchAndDisplay',
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
                    opcode: 'getElevation',
                    blockType: BlockType.REPORTER,
                    text: '緯度 [LATITUDE] 経度 [LONGITUDE] の場所の高さ(m)',
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
                    opcode: 'moveToCoordinateWithSpeed',
                    blockType: BlockType.COMMAND,
                    text: '秒速 [SPEED] メートルで緯度 [LATITUDE] 経度 [LONGITUDE] まで移動する',
                    arguments: {
                        SPEED: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 1.0
                        },
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
                }, 
                {
                    opcode: 'findPathToPathList',
                    blockType: BlockType.COMMAND,
                    text: 'ノード[START_NODE_ID]からノード[GOAL_NODE_ID]への最短経路を「Path」リストに追加',
                    arguments: {
                        START_NODE_ID: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 255479223
                        },
                        GOAL_NODE_ID: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 255479334
                        }
                    }
                },
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
