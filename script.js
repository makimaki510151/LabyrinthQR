// script.js
// Web Audio APIのコンテキストを保持する変数
let audioCtx = null;
let masterGainNode = null;
const DEFAULT_VOLUME = 0.3; 

// サーバーURLを設定 (ご自身のサーバーアドレスに置き換えてください)
// 例: const SERVER_URL = 'ws://your-server-ip:8080';
const SERVER_URL = 'ws://localhost:8080'; 

// WebSocket接続
let ws = null;
let clientRole = null; // 'pc' or 'controller'
let assignedPlayer = null; // 'P1' or 'P2' (スマホのみ)

// 音を生成して再生する汎用関数 (変更なし)
function playSound(type) {
    if (!audioCtx || !masterGainNode) {
        return;
    }

    const oscillator = audioCtx.createOscillator();
    const soundGainNode = audioCtx.createGain(); 

    oscillator.connect(soundGainNode);
    soundGainNode.connect(masterGainNode); 

    let freq, duration, initialVolume;

    switch (type) {
        case 'move':
            freq = 440; 
            duration = 0.05;
            initialVolume = 0.3; 
            break;
        case 'hit':
            freq = 120; 
            duration = 0.1;
            initialVolume = 0.5;
            break;
        case 'clear':
            freq = 660; 
            duration = 0.5;
            initialVolume = 0.4;
            oscillator.frequency.linearRampToValueAtTime(880, audioCtx.currentTime + 0.2);
            break;
        default:
            return;
    }

    oscillator.frequency.setValueAtTime(freq, audioCtx.currentTime);
    soundGainNode.gain.setValueAtTime(initialVolume, audioCtx.currentTime); 

    oscillator.start();
    soundGainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    oscillator.stop(audioCtx.currentTime + duration);
}

// 迷路解析のためのカラーコード定数 (RGB形式)
const COLOR_MAP = {
    WALL: '#333333',     // 壁
    PATH: '#FFFFFF',     // 通路 (通常描画はしない)
    START: '#0000FF',    // 青 (スタート地点)
    GOAL: '#FF0000'      // 赤 (ゴール地点)
};


// 迷路生成クラス (変更なし)
class MazeGenerator {
    static generate(width, height, startCoords, goalCoords) {
        const GRID_WIDTH = width;
        const GRID_HEIGHT = height;

        const grid = Array(GRID_HEIGHT).fill(0).map(() => Array(GRID_WIDTH).fill(0));

        let currentCell = { x: 1, y: 1 }; 
        grid[currentCell.y][currentCell.x] = 1;
        
        const walls = [];

        const addWalls = (x, y) => {
            [[0, 1], [0, -1], [1, 0], [-1, 0]].forEach(([dx, dy]) => {
                const wallX = x + dx;
                const wallY = y + dy;
                if (wallX > 0 && wallX < GRID_WIDTH - 1 && wallY > 0 && wallY < GRID_HEIGHT - 1 && grid[wallY][wallX] === 0) {
                    // 重複を避けるためにSetで管理する方が効率的だが、ここではシンプルに配列にpush
                    if (!walls.some(w => w.x === wallX && w.y === wallY)) {
                        walls.push({ x: wallX, y: wallY });
                    }
                }
            });
        };
        addWalls(currentCell.x, currentCell.y);


        while (walls.length > 0) {
            const wallIndex = Math.floor(Math.random() * walls.length);
            const wall = walls[wallIndex];
            walls.splice(wallIndex, 1); 

            const x = wall.x;
            const y = wall.y;
            
            let cell1 = null; 
            let cell2 = null; 

            if (x % 2 === 1 && y % 2 === 0) {
                cell1 = { x: x, y: y - 1 };
                cell2 = { x: x, y: y + 1 };
            } 
            else if (x % 2 === 0 && y % 2 === 1) {
                cell1 = { x: x - 1, y: y };
                cell2 = { x: x + 1, y: y };
            } else {
                continue; 
            }

            const isCell1Path = grid[cell1.y][cell1.x] === 1;
            const isCell2Path = grid[cell2.y][cell2.x] === 1;

            if (isCell1Path !== isCell2Path) {
                grid[y][x] = 1;

                const newCell = isCell1Path ? cell2 : cell1;
                grid[newCell.y][newCell.x] = 1;

                addWalls(newCell.x, newCell.y);
            }
        }

        const mazeData = {
            width: GRID_WIDTH,
            height: GRID_HEIGHT,
            start: startCoords,
            goal: goalCoords,
            walls: []
        };

        for (let y = 0; y < GRID_HEIGHT; y++) {
            for (let x = 0; x < GRID_WIDTH; x++) {
                if (grid[y][x] === 0) {
                    mazeData.walls.push({ x: x, y: y });
                }
            }
        }

        return mazeData;
    }
}


// Playerクラス
class Player {
    constructor(id, startX, startY, color) {
        this.id = id; 
        this.x = startX;
        this.y = startY;
        this.color = color;
        this.isGoal = false;
        this.visitedCells = new Set([`${startX},${startY}`]);
    }

    // 移動処理
    move(dx, dy, maze) {
        const newX = this.x + dx;
        const newY = this.y + dy;

        if (newX >= 0 && newX < maze.width && newY >= 0 && newY < maze.height && !maze.isWall(newX, newY)) {
            this.x = newX;
            this.y = newY;
            this.visitedCells.add(`${newX},${newY}`);
            return true;
        }
        return false;
    }

    // ゴールに到達したかチェック
    isAtGoal(maze) {
        return this.x === maze.goal.x && this.y === maze.goal.y;
    }
}

// 迷路クラス (変更なし)
class Maze {
    constructor(data) {
        this.width = data.width;
        this.height = data.height;
        this.start = data.start;
        this.goal = data.goal;
        this.walls = new Set();

        if (data.walls && Array.isArray(data.walls)) {
            data.walls.forEach(wall => {
                this.walls.add(`${wall.x},${wall.y}`);
            });
        }
    }

    isWall(x, y) {
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
            return true;
        }
        return this.walls.has(`${x},${y}`);
    }
}

// ゲームクラス
class MazeGame {
    constructor() {
        this.currentScreen = 'select'; // 初期画面をselectに変更
        this.maze = null;
        this.players = {}; 
        
        this.p1Canvas = null;
        this.p1Ctx = null;
        this.p2Canvas = null;
        this.p2Ctx = null;
        this.minimapCanvas = null;
        this.minimapCtx = null;
        
        this.mazeSize = 45; // 45x45固定
        this.pViewSize = 5; // 5x5のプレイヤービュー
        this.pCellSize = 450 / this.pViewSize; // プレイヤービューのセルサイズ (450/5 = 90px)
        this.mCellSize = 450 / this.mazeSize; // ミニマップのセルサイズ (225/45 = 5px)
        
        this.lastMoveTime = { P1: 0, P2: 0 };
        this.moveDelay = 150; 

        this.init();
    }

    async init() {
        this.setupEventListeners();
        this.initAudio();
        this.showScreen('select');
    }

    // WebSocket接続処理
    connectWebSocket(role) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
        clientRole = role;
        
        const statusElement = document.getElementById(role === 'pc' ? 'pc-connection-status' : 'controller-connection-status');
        statusElement.textContent = 'サーバー接続中...';

        ws = new WebSocket(SERVER_URL);

        ws.onopen = () => {
            console.log('WebSocket connected as:', role);
            statusElement.textContent = 'サーバー接続済み';
            
            // サーバーに役割を登録
            ws.send(JSON.stringify({ type: 'register', role: role }));

            if (role === 'pc') {
                this.generateQRCode();
                document.getElementById('start-button').disabled = true;
            }
        };

        ws.onmessage = (event) => {
            this.handleServerMessage(event.data);
        };

        ws.onclose = () => {
            console.log('WebSocket closed. Reconnecting in 3s...');
            statusElement.textContent = 'サーバー接続切断。再接続を試みます...';
            setTimeout(() => this.connectWebSocket(role), 3000);
        };

        ws.onerror = (error) => {
            console.error('WebSocket Error:', error);
            statusElement.textContent = '接続エラーが発生しました。';
        };
    }

    // サーバーからのメッセージ処理
    handleServerMessage(data) {
        const msg = JSON.parse(data);

        if (clientRole === 'pc') {
            this.handlePCMessage(msg);
        } else if (clientRole === 'controller') {
            this.handleControllerMessage(msg);
        }
    }

    handlePCMessage(msg) {
        switch (msg.type) {
            case 'controllerStatus':
                this.updateControllerStatus(msg.p1Connected, msg.p2Connected);
                break;
            case 'playerMove':
                this.receiveMoveCommand(msg.player, msg.dx, msg.dy);
                break;
            case 'error':
                console.error('Server Error:', msg.message);
                break;
        }
    }

    handleControllerMessage(msg) {
        const titleElement = document.getElementById('controller-player-title');
        const statusElement = document.getElementById('controller-game-status');
        const dpadButtons = document.querySelectorAll('.dpad-button');

        switch (msg.type) {
            case 'assigned':
                assignedPlayer = msg.player;
                titleElement.textContent = `PLAYER ${msg.player.slice(-1)} コントローラー`;
                titleElement.style.color = (msg.player === 'P1') ? '#4CAF50' : '#2196F3';
                break;
            case 'gameStatus':
                if (msg.status === 'started') {
                    statusElement.textContent = 'レース中！';
                    dpadButtons.forEach(btn => btn.disabled = false);
                } else if (msg.status === 'finished') {
                    statusElement.textContent = `${msg.winner} の勝利！ゲーム終了`;
                    dpadButtons.forEach(btn => btn.disabled = true);
                } else if (msg.status === 'waiting') {
                    statusElement.textContent = 'PCクライアントが切断されました。待機中...';
                    dpadButtons.forEach(btn => btn.disabled = true);
                }
                break;
            case 'error':
                statusElement.textContent = `エラー: ${msg.message}`;
                break;
        }
    }
    
    // PC: コントローラー接続状態の更新
    updateControllerStatus(p1Connected, p2Connected) {
        const p1Status = document.getElementById('p1-connect-status');
        const p2Status = document.getElementById('p2-connect-status');
        const startButton = document.getElementById('start-button');

        p1Status.textContent = p1Connected ? 'P1: 接続済み' : 'P1: 待機中';
        p1Status.className = 'status-indicator ' + (p1Connected ? 'connected' : 'waiting');

        p2Status.textContent = p2Connected ? 'P2: 接続済み' : 'P2: 待機中';
        p2Status.className = 'status-indicator ' + (p2Connected ? 'connected' : 'waiting');

        // P1, P2両方接続されている場合にゲーム開始ボタンを有効化
        startButton.disabled = !(p1Connected && p2Connected);
    }

    // PC: サーバーからの移動コマンドを受信してプレイヤーを移動
    receiveMoveCommand(player, dx, dy) {
        if (this.currentScreen !== 'game') return;
        const now = Date.now();
        
        // 移動ディレイチェック
        if (now - this.lastMoveTime[player] < this.moveDelay) return;
        
        this.lastMoveTime[player] = now;
        this.movePlayer(player, dx, dy);
    }
    
    // QRコード生成
    generateQRCode() {
        const currentUrl = window.location.href; // Github PagesのURL
        const qrContent = currentUrl + '#controller'; // コントローラーモードに遷移するフラグを追加
        
        document.getElementById('qrcode').innerHTML = ''; // 既存のQRコードをクリア
        new QRCode(document.getElementById("qrcode"), {
            text: qrContent,
            width: 150,
            height: 150,
            colorDark : "#000000",
            colorLight : "#ffffff",
            correctLevel : QRCode.CorrectLevel.H
        });

        document.getElementById('qr-status').textContent = 'スマホでスキャンしてコントローラーとして接続';
    }


    initAudio() { /* 変更なし */
        const audioInitHandler = () => {
            if (!audioCtx) {
                try {
                    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    masterGainNode = audioCtx.createGain();
                    masterGainNode.connect(audioCtx.destination);
                    masterGainNode.gain.setValueAtTime(DEFAULT_VOLUME, audioCtx.currentTime);
                } catch (e) {
                    console.warn('Web Audio APIはサポートされていません:', e);
                    return;
                }
            }

            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }

            document.removeEventListener('click', audioInitHandler);
            document.removeEventListener('keydown', audioInitHandler);
        };

        document.addEventListener('click', audioInitHandler);
        document.addEventListener('keydown', audioInitHandler);
    }

    setupEventListeners() {
        // 画面選択イベント
        document.getElementById('select-pc-button').addEventListener('click', () => {
            this.connectWebSocket('pc');
            this.showScreen('pc-title');
        });
        document.getElementById('select-controller-button').addEventListener('click', () => {
            this.connectWebSocket('controller');
            this.showScreen('controller');
            this.setupControllerEvents(); // スマホコントローラーのイベント設定
        });
        
        // PC画面イベント
        document.getElementById('start-button').addEventListener('click', () => {
            this.startGame();
            // サーバーにゲーム開始を通知
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'gameStart' }));
            }
        });

        document.getElementById('back-to-title').addEventListener('click', () => {
            this.showScreen('pc-title');
        });
        document.getElementById('pc-back-to-select').addEventListener('click', () => {
            this.showScreen('select');
            if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        });
        document.getElementById('back-to-select-clear').addEventListener('click', () => {
            this.showScreen('select');
            if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        });
        
        // スマホ画面イベント
        document.getElementById('controller-back-to-select').addEventListener('click', () => {
            this.showScreen('select');
            if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        });
        
        // URLハッシュチェック (コントローラー画面への直接遷移)
        if (window.location.hash === '#controller') {
            this.connectWebSocket('controller');
            this.showScreen('controller');
            this.setupControllerEvents();
        }
    }
    
    // スマホコントローラーのボタンイベント設定
    setupControllerEvents() {
        document.querySelectorAll('.dpad-button').forEach(button => {
            // イベントリスナーを削除してから追加 (重複防止)
            button.removeEventListener('touchstart', this.handleControllerTouchStart);
            button.removeEventListener('touchend', this.handleControllerTouchEnd);

            // タッチイベントを使用して即座に反応
            button.addEventListener('touchstart', (e) => this.handleControllerTouchStart(e, button), { passive: true });
            button.addEventListener('touchend', (e) => this.handleControllerTouchEnd(e, button));
        });
    }

    // タッチ開始: 移動コマンドを送信
    handleControllerTouchStart(e, button) {
        if (!assignedPlayer || button.disabled) return;
        const [dx, dy] = button.dataset.dir.split(',').map(Number);
        
        if (ws && ws.readyState === WebSocket.OPEN && (dx !== 0 || dy !== 0)) {
            ws.send(JSON.stringify({ 
                type: 'move', 
                player: assignedPlayer, 
                dx: dx, 
                dy: dy 
            }));
            
            // 連続移動を考慮して、ボタンをホールドしている間は定期的に送信 (サーバー側でディレイ処理)
            // このゲームではサーバー側のディレイで制御するため、クライアントからは1回送信でOKとします。
            // サーバー側でディレイ処理が実装されているため、ここでは1回のみの送信に留めます。
        }
    }
    
    // タッチ終了: 何もしない (moveDelayで制御するため)
    handleControllerTouchEnd(e, button) {
        // 必要であれば、ここで移動終了の信号を送ることもできるが、このゲームでは不要
    }

    // ゲームパッドポーリングの削除
    // startGamepadPolling() { /* 削除 */ }
    // updateGamepadStatus() { /* PCではサーバーからの情報で更新 */ }
    // pollGamepads() { /* 削除 */ }
    // handleGamepadInput() { /* 削除 */ }
    
    showScreen(screenName) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
        document.getElementById(`${screenName}-screen`).classList.add('active');
        this.currentScreen = screenName;
    }
    
    startGame() {
        if (clientRole !== 'pc') return; // PCクライアントのみゲームを開始できる

        const MAZE_SIZE = this.mazeSize;
        const startCoords = { x: 1, y: 1 };
        const goalCoords = { x: MAZE_SIZE - 2, y: MAZE_SIZE - 2 };

        const mazeData = MazeGenerator.generate(MAZE_SIZE, MAZE_SIZE, startCoords, goalCoords);
        this.maze = new Maze(mazeData);

        this.players['P1'] = new Player('P1', this.maze.start.x, this.maze.start.y, '#4CAF50');
        this.players['P2'] = new Player('P2', this.maze.start.x, this.maze.start.y, '#2196F3');

        // 3つのキャンバスとコンテキストを取得
        this.p1Canvas = document.getElementById('p1-canvas');
        this.p1Ctx = this.p1Canvas.getContext('2d');
        this.p2Canvas = document.getElementById('p2-canvas');
        this.p2Ctx = this.p2Canvas.getContext('2d');
        this.minimapCanvas = document.getElementById('minimap-canvas');
        this.minimapCtx = this.minimapCanvas.getContext('2d');

        this.showScreen('game');
        this.updatePlayerStatus(); // 初期ステータス表示
        this.render();
    }

    // 移動処理 (PCクライアントのみ実行)
    movePlayer(playerId, dx, dy) {
        if (this.currentScreen !== 'game' || clientRole !== 'pc') return;
        
        const player = this.players[playerId];
        if (!player || player.isGoal) return;
        
        const moved = player.move(dx, dy, this.maze);

        if (moved) {
            playSound('move');
            this.render(); // 描画更新
            this.updatePlayerStatus();

            if (player.isAtGoal(this.maze)) {
                this.completeLevel(playerId);
            }
        } else {
            const newX = player.x + dx;
            const newY = player.y + dy;
            if (this.maze.isWall(newX, newY)) {
                playSound('hit');
            }
        }
    }
    
    // プレイヤーのステータス更新
    updatePlayerStatus() {
        const p1Status = document.getElementById('status-p1').querySelector('p');
        const p2Status = document.getElementById('status-p2').querySelector('p');
        
        if (this.players.P1.isGoal) {
            p1Status.textContent = "ゴール！";
        } else {
            p1Status.textContent = "走行中";
        }

        if (this.players.P2.isGoal) {
            p2Status.textContent = "ゴール！";
        } else {
            p2Status.textContent = "走行中";
        }
    }

    completeLevel(winnerId) {
        playSound('clear');

        // 既にゴールしているプレイヤーがいたら処理しない
        if (this.players.P1.isGoal || this.players.P2.isGoal) return;
        
        this.players[winnerId].isGoal = true;
        this.updatePlayerStatus(); // ステータスを最終更新

        document.getElementById('winner-title').textContent = '勝者決定！';
        document.getElementById('clear-message').textContent = `${winnerId} の勝利！`;

        const winnerColor = this.players[winnerId].color;
        document.getElementById('clear-screen').style.backgroundColor = winnerColor + '30';
        document.getElementById('winner-title').style.color = winnerColor;

        // サーバーにゲーム終了を通知
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'gameOver', winner: winnerId }));
        }

        this.showScreen('clear');
    }

    // render関数 (3つのビューの描画)
    render() {
        this.renderMinimap();
        this.renderPlayerView('P1', this.p1Ctx, this.p1Canvas);
        this.renderPlayerView('P2', this.p2Ctx, this.p2Canvas);
    }

    // ミニマップの描画 (探索済み通路のみ表示)
    renderMinimap() {
        const ctx = this.minimapCtx;
        const canvas = this.minimapCanvas;
        const CELL_SIZE = this.mCellSize; // 5px

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // 背景を黒にする
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const allVisited = new Set([
            ...this.players.P1.visitedCells, 
            ...this.players.P2.visitedCells
        ]);

        for (let y = 0; y < this.maze.height; y++) {
            for (let x = 0; x < this.maze.width; x++) {
                const drawX = x * CELL_SIZE;
                const drawY = y * CELL_SIZE;

                const coord = `${x},${y}`;
                const isWall = this.maze.isWall(x, y);

                // 探索済みの通路、スタート、ゴールのみを描画
                if (allVisited.has(coord) && !isWall) {
                    ctx.fillStyle = '#D3D3D3'; // 通路の色 (薄いグレー)
                    ctx.fillRect(drawX, drawY, CELL_SIZE, CELL_SIZE);
                } else if (x === this.maze.start.x && y === this.maze.start.y) {
                    ctx.fillStyle = COLOR_MAP.START;
                    ctx.fillRect(drawX, drawY, CELL_SIZE, CELL_SIZE);
                } else if (x === this.maze.goal.x && y === this.maze.goal.y) {
                    ctx.fillStyle = COLOR_MAP.GOAL;
                    ctx.fillRect(drawX, drawY, CELL_SIZE, CELL_SIZE);
                }
            }
        }
        
        // プレイヤーの描画 (ミニマップ上ではドットで)
        ['P1', 'P2'].forEach(playerId => {
            const player = this.players[playerId];
            if (player) {
                const playerX = player.x * CELL_SIZE;
                const playerY = player.y * CELL_SIZE;
                
                ctx.fillStyle = player.color;
                ctx.fillRect(playerX, playerY, CELL_SIZE, CELL_SIZE);
            }
        });
    }

    // プレイヤーの周囲5x5ビューの描画 (拡大表示)
    renderPlayerView(playerId, ctx, canvas) {
        const player = this.players[playerId];
        if (!player) return;

        const VIEW_SIZE = this.pViewSize; // 5
        const HALF_VIEW = Math.floor(VIEW_SIZE / 2); // 2
        const CELL_SIZE = this.pCellSize; // 90px

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // 描画範囲の中心座標 (プレイヤーのいる位置)
        const centerX = player.x;
        const centerY = player.y;

        // 描画する迷路のセル座標をループ
        for (let viewY = 0; viewY < VIEW_SIZE; viewY++) {
            for (let viewX = 0; viewX < VIEW_SIZE; viewX++) {
                // 迷路の絶対座標
                const mazeX = centerX + (viewX - HALF_VIEW);
                const mazeY = centerY + (viewY - HALF_VIEW);
                
                // キャンバス上の描画座標
                const drawX = viewX * CELL_SIZE;
                const drawY = viewY * CELL_SIZE;
                
                // 迷路の壁/通路判定
                const isWall = this.maze.isWall(mazeX, mazeY);
                
                // 迷路の描画
                if (isWall) {
                    ctx.fillStyle = COLOR_MAP.WALL;
                    ctx.fillRect(drawX, drawY, CELL_SIZE, CELL_SIZE);
                } else {
                    ctx.fillStyle = COLOR_MAP.PATH;
                    ctx.fillRect(drawX, drawY, CELL_SIZE, CELL_SIZE);
                }
                
                // スタートとゴールの描画
                if (mazeX === this.maze.start.x && mazeY === this.maze.start.y) {
                    ctx.fillStyle = COLOR_MAP.START;
                    ctx.fillRect(drawX, drawY, CELL_SIZE, CELL_SIZE);
                } 
                if (mazeX === this.maze.goal.x && mazeY === this.maze.goal.y) {
                    ctx.fillStyle = COLOR_MAP.GOAL;
                    ctx.fillRect(drawX, drawY, CELL_SIZE, CELL_SIZE);
                }
                
                // プレイヤーの描画
                if (mazeX === player.x && mazeY === player.y) {
                    ctx.fillStyle = player.color; 
                    ctx.beginPath();
                    ctx.arc(drawX + CELL_SIZE / 2, drawY + CELL_SIZE / 2, CELL_SIZE * 0.4, 0, Math.PI * 2);
                    ctx.fill();

                    // ゴールしている場合は外枠
                    if (player.isGoal) {
                        ctx.strokeStyle = 'gold';
                        ctx.lineWidth = 4;
                        ctx.stroke();
                    }
                }
            }
        }
    }
}

// ゲーム開始
document.addEventListener('DOMContentLoaded', () => {
    window.game = new MazeGame();
});