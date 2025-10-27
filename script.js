// script.js
// Web Audio APIのコンテキストを保持する変数
let audioCtx = null;
let masterGainNode = null;
const DEFAULT_VOLUME = 0.3; 

// サーバーURLを設定 (ご自身のサーバーアドレスに置き換えてください)
// QRコードの生成で利用するため、ローカルIPアドレスや公開URLを使用してください。
const LOCAL_IP = 'localhost'; // サーバーを立てたPCのIPアドレスまたはホスト名
const SERVER_PORT = 8080;
const SERVER_URL = `ws://${LOCAL_IP}:${SERVER_PORT}`; 

// WebSocket接続
let ws = null;
let clientRole = null; // 'pc' or 'controller'
let sessionId = null; // 現在のルームID
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

// 迷路解析のためのカラーコード定数
const COLOR_MAP = {
    WALL: '#333333',
    PATH: '#FFFFFF',
    START: '#0000FF',
    GOAL: '#FF0000',
    P1_COLOR: '#4CAF50',
    P2_COLOR: '#2196F3'
};

// MazeGenerator, Player, Maze クラス (変更なし - ロジックは維持)
class MazeGenerator { /* ... (前回のコードから変更なし) ... */
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


class Player { /* ... (前回のコードから変更なし) ... */
    constructor(id, startX, startY, color) {
        this.id = id; 
        this.x = startX;
        this.y = startY;
        this.color = color;
        this.isGoal = false;
        this.visitedCells = new Set([`${startX},${startY}`]);
    }

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

    isAtGoal(maze) {
        return this.x === maze.goal.x && this.y === maze.goal.y;
    }
}

class Maze { /* ... (前回のコードから変更なし) ... */
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
        this.currentScreen = 'select'; 
        this.maze = null;
        this.players = {}; 
        
        this.p1Canvas = null;
        this.p1Ctx = null;
        this.p2Canvas = null;
        this.p2Ctx = null;
        this.minimapCanvas = null;
        this.minimapCtx = null;
        
        this.mazeSize = 45; 
        this.pViewSize = 5; 
        this.pCellSize = 450 / this.pViewSize; 
        this.mCellSize = 450 / this.mazeSize; 
        
        this.lastMoveTime = { P1: 0, P2: 0 };
        this.moveDelay = 150; 

        this.init();
    }

    async init() {
        this.setupEventListeners();
        this.initAudio();
        this.showScreen('select');
        this.checkUrlForController();
    }

    // URLのハッシュをチェックし、コントローラー接続画面に遷移させる
    checkUrlForController() {
        const urlParams = new URLSearchParams(window.location.search);
        const room = urlParams.get('room');
        
        if (room) {
            this.connectWebSocket('controller', room);
            document.getElementById('room-id-input').value = room.toUpperCase();
            this.showScreen('controller'); // 即座にコントローラー画面へ
            this.setupControllerEvents(); 
        }
    }

    // WebSocket接続処理
    connectWebSocket(role, roomId = null) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
        clientRole = role;
        sessionId = roomId; // コントローラーの場合は入力されたIDを設定
        
        const statusElement = document.getElementById(role === 'pc' ? 'pc-connection-status' : 'controller-connection-status');
        if (role === 'controller') {
            statusElement.textContent = 'サーバー接続中...';
        }
        
        ws = new WebSocket(SERVER_URL);

        ws.onopen = () => {
            console.log('WebSocket connected as:', role);
            statusElement.textContent = 'サーバー接続済み';
            
            // サーバーに役割を登録 (PCはIDなし, コントローラーはIDあり)
            ws.send(JSON.stringify({ 
                type: 'register', 
                role: role, 
                sessionId: sessionId // コントローラーの場合のみIDを送信
            }));

            if (role === 'pc') {
                document.getElementById('room-info-area').style.display = 'block';
                document.getElementById('start-button').disabled = true;
            }
        };

        ws.onmessage = (event) => {
            this.handleServerMessage(event.data);
        };

        ws.onclose = () => {
            console.log('WebSocket closed. Reconnecting in 3s...');
            statusElement.textContent = 'サーバー接続切断。再接続を試みます...';
            // PCの場合は自動再接続を試みない
            if (clientRole === 'controller') {
                 setTimeout(() => this.connectWebSocket(role, sessionId), 3000);
            } else {
                 document.getElementById('room-info-area').style.display = 'none';
                 document.getElementById('room-id').textContent = '--';
            }
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
            case 'sessionCreated':
                sessionId = msg.sessionId;
                document.getElementById('room-id').textContent = sessionId;
                // PC自身のIPアドレスを取得してQRコードを生成（ここでは仮にローカルホストを使用）
                this.generateQRCode(sessionId, LOCAL_IP); 
                document.getElementById('gamepad-status').textContent = `ルームID: ${sessionId}`;
                break;
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
                const playerNum = assignedPlayer.slice(-1);
                titleElement.textContent = `PLAYER ${playerNum} コントローラー`;
                titleElement.className = assignedPlayer === 'P1' ? 'p1-color' : 'p2-color';
                
                // ボタンにプレイヤーカラーを適用
                dpadButtons.forEach(btn => {
                    btn.classList.remove('p1-color', 'p2-color');
                    if (!btn.classList.contains('center')) {
                        btn.classList.add(assignedPlayer === 'P1' ? 'p1-color' : 'p2-color');
                    }
                });
                break;
            case 'gameStatus':
                if (msg.status === 'started') {
                    statusElement.textContent = 'レース中！';
                    dpadButtons.forEach(btn => btn.disabled = false);
                } else if (msg.status === 'finished') {
                    statusElement.textContent = `${msg.winner} の勝利！ゲーム終了`;
                    dpadButtons.forEach(btn => btn.disabled = true);
                }
                break;
            case 'serverClosed':
                statusElement.textContent = msg.message;
                dpadButtons.forEach(btn => btn.disabled = true);
                break;
            case 'error':
                document.getElementById('entry-status-message').textContent = msg.message;
                this.showScreen('controller-entry'); // エラーなら入力画面に戻す
                if (ws && ws.readyState === WebSocket.OPEN) ws.close();
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
        
        // サーバー側でもディレイ処理を推奨しますが、クライアント側でも処理
        if (now - this.lastMoveTime[player] < this.moveDelay) return;
        
        this.lastMoveTime[player] = now;
        this.movePlayer(player, dx, dy);
    }
    
    // QRコード生成 (URLにroomIDを含める)
    generateQRCode(roomId, serverIp) {
        // 例: http://githubpages.com/?room=ABCD
        const base = window.location.href.split('?')[0].split('#')[0]; // URLのクエリとハッシュをクリア
        const qrContent = `${base}?room=${roomId}`; 
        
        document.getElementById('qrcode').innerHTML = '';
        new QRCode(document.getElementById("qrcode"), {
            text: qrContent,
            width: 200,
            height: 200,
            colorDark : "#000000",
            colorLight : "#ffffff",
            correctLevel : QRCode.CorrectLevel.H
        });

        document.getElementById('qr-status').textContent = `PCのIP: ${serverIp}`;
    }


    initAudio() { /* ユーザー操作でAudioContextを初期化するロジック (変更なし) */
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
            this.showScreen('controller-entry');
        });
        
        // コントローラーID入力イベント
        document.getElementById('connect-room-button').addEventListener('click', () => {
            const inputId = document.getElementById('room-id-input').value.toUpperCase().trim();
            if (inputId.length === 4) {
                this.connectWebSocket('controller', inputId);
                this.showScreen('controller');
                this.setupControllerEvents();
            } else {
                document.getElementById('entry-status-message').textContent = 'ルームIDは4桁で入力してください。';
            }
        });

        // PC画面イベント
        document.getElementById('start-button').addEventListener('click', () => {
            this.startGame();
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'gameStart', sessionId: sessionId }));
            }
        });

        document.getElementById('back-to-title').addEventListener('click', () => {
            this.showScreen('pc-title');
        });
        
        // 選択画面に戻るボタン
        document.getElementById('pc-back-to-select').addEventListener('click', () => {
            this.showScreen('select');
            if (ws && ws.readyState === WebSocket.OPEN) ws.close();
            sessionId = null;
        });
        document.getElementById('entry-back-to-select').addEventListener('click', () => {
            this.showScreen('select');
            if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        });
        document.getElementById('controller-back-to-select').addEventListener('click', () => {
            this.showScreen('select');
            if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        });
        document.getElementById('back-to-select-clear').addEventListener('click', () => {
            this.showScreen('select');
            if (ws && ws.readyState === WebSocket.OPEN) ws.close();
            sessionId = null;
        });
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
        if (!assignedPlayer || button.disabled || !sessionId) return;
        const [dx, dy] = button.dataset.dir.split(',').map(Number);
        
        if (ws && ws.readyState === WebSocket.OPEN && (dx !== 0 || dy !== 0)) {
            ws.send(JSON.stringify({ 
                type: 'move', 
                sessionId: sessionId,
                player: assignedPlayer, 
                dx: dx, 
                dy: dy 
            }));
        }
    }
    
    // タッチ終了: 何もしない (moveDelayで制御するため)
    handleControllerTouchEnd(e, button) {
        //
    }
    
    showScreen(screenName) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
        document.getElementById(`${screenName}-screen`).classList.add('active');
        this.currentScreen = screenName;
    }
    
    startGame() {
        if (clientRole !== 'pc') return; 

        const MAZE_SIZE = this.mazeSize;
        const startCoords = { x: 1, y: 1 };
        const goalCoords = { x: MAZE_SIZE - 2, y: MAZE_SIZE - 2 };

        const mazeData = MazeGenerator.generate(MAZE_SIZE, MAZE_SIZE, startCoords, goalCoords);
        this.maze = new Maze(mazeData);

        this.players['P1'] = new Player('P1', this.maze.start.x, this.maze.start.y, COLOR_MAP.P1_COLOR);
        this.players['P2'] = new Player('P2', this.maze.start.x, this.maze.start.y, COLOR_MAP.P2_COLOR);

        // 3つのキャンバスとコンテキストを取得
        this.p1Canvas = document.getElementById('p1-canvas');
        this.p1Ctx = this.p1Canvas.getContext('2d');
        this.p2Canvas = document.getElementById('p2-canvas');
        this.p2Ctx = this.p2Canvas.getContext('2d');
        this.minimapCanvas = document.getElementById('minimap-canvas');
        this.minimapCtx = this.minimapCanvas.getContext('2d');

        this.showScreen('game');
        this.updatePlayerStatus(); 
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
            this.render(); 

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
        this.updatePlayerStatus();
    }
    
    // プレイヤーのステータス更新
    updatePlayerStatus() { /* ... (前回のコードから変更なし) ... */
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

        if (this.players.P1.isGoal || this.players.P2.isGoal) return;
        
        this.players[winnerId].isGoal = true;
        this.updatePlayerStatus(); 

        document.getElementById('winner-title').textContent = '勝者決定！';
        document.getElementById('clear-message').textContent = `${winnerId} の勝利！`;

        const winnerColor = this.players[winnerId].color;
        document.getElementById('clear-screen').style.backgroundColor = winnerColor + '30';
        document.getElementById('winner-title').style.color = winnerColor;

        // サーバーにゲーム終了を通知
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'gameOver', sessionId: sessionId, winner: winnerId }));
        }

        this.showScreen('clear');
    }

    // render関数 (3つのビューの描画)
    render() {
        this.renderMinimap();
        this.renderPlayerView('P1', this.p1Ctx, this.p1Canvas);
        this.renderPlayerView('P2', this.p2Ctx, this.p2Canvas);
    }

    // ミニマップの描画 (変更なし)
    renderMinimap() { /* ... (前回のコードから変更なし) ... */
        const ctx = this.minimapCtx;
        const canvas = this.minimapCanvas;
        const CELL_SIZE = this.mCellSize; 

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
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

                if (allVisited.has(coord) && !isWall) {
                    ctx.fillStyle = '#D3D3D3'; 
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

    // プレイヤーの周囲5x5ビューの描画 (変更なし)
    renderPlayerView(playerId, ctx, canvas) { /* ... (前回のコードから変更なし) ... */
        const player = this.players[playerId];
        if (!player) return;

        const VIEW_SIZE = this.pViewSize;
        const HALF_VIEW = Math.floor(VIEW_SIZE / 2);
        const CELL_SIZE = this.pCellSize;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        const centerX = player.x;
        const centerY = player.y;

        for (let viewY = 0; viewY < VIEW_SIZE; viewY++) {
            for (let viewX = 0; viewX < VIEW_SIZE; viewX++) {
                const mazeX = centerX + (viewX - HALF_VIEW);
                const mazeY = centerY + (viewY - HALF_VIEW);
                
                const drawX = viewX * CELL_SIZE;
                const drawY = viewY * CELL_SIZE;
                
                const isWall = this.maze.isWall(mazeX, mazeY);
                
                if (isWall) {
                    ctx.fillStyle = COLOR_MAP.WALL;
                    ctx.fillRect(drawX, drawY, CELL_SIZE, CELL_SIZE);
                } else {
                    ctx.fillStyle = COLOR_MAP.PATH;
                    ctx.fillRect(drawX, drawY, CELL_SIZE, CELL_SIZE);
                }
                
                if (mazeX === this.maze.start.x && mazeY === this.maze.start.y) {
                    ctx.fillStyle = COLOR_MAP.START;
                    ctx.fillRect(drawX, drawY, CELL_SIZE, CELL_SIZE);
                } 
                if (mazeX === this.maze.goal.x && mazeY === this.maze.goal.y) {
                    ctx.fillStyle = COLOR_MAP.GOAL;
                    ctx.fillRect(drawX, drawY, CELL_SIZE, CELL_SIZE);
                }
                
                if (mazeX === player.x && mazeY === player.y) {
                    ctx.fillStyle = player.color; 
                    ctx.beginPath();
                    ctx.arc(drawX + CELL_SIZE / 2, drawY + CELL_SIZE / 2, CELL_SIZE * 0.4, 0, Math.PI * 2);
                    ctx.fill();

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