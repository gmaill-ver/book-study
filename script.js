// ===== StudyBook Application - 完全版（スワイプ機能・画像修正付き） =====

class StudyBookApp {
    constructor() {
        // Firebase設定
        this.firebaseConfig = {
            apiKey: "AIzaSyCRRsnIRzveG6B7XzDhUR-OoBWq-SY-5Ew",
            authDomain: "book-study-1f25e.firebaseapp.com",
            projectId: "book-study-1f25e",
            storageBucket: "book-study-1f25e.firebasestorage.app",
            messagingSenderId: "716923175090",
            appId: "1:716923175090:web:2cc8c093c6cdf4ddbe09ab"
        };

        // 状態管理
        this.currentUser = null;
        this.notesMap = new Map();
        this.currentNote = null;
        this.currentPage = 0;
        this.isEditing = false;
        this.isOnline = navigator.onLine;
        this.isAuthMode = 'login';
        this.viewMode = 'shelf';

        // Firebase インスタンス
        this.firebaseApp = null;
        this.auth = null;
        this.db = null;
        this.storage = null;
        this.firebaseInitialized = false;

        // リアルタイムリスナー
        this.listeners = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.reconnectTimeout = null;

        // 検索エンジン
        this.fuseInstance = null;

        // パフォーマンス改善
        this.dataCache = new Map();
        this.lastFetchTime = 0;
        this.cacheTimeout = 30000;

        // レート制限
        this.rateLimiter = new Map();

        // 共有ノート処理
        this.pendingSharedNoteId = null;
        this.dataLoadingComplete = false;

        // パスワード保護機能
        this.passwordCache = new Map();
        this.pendingPasswordNote = null;

        // スワイプ処理用
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchEndX = 0;
        this.touchEndY = 0;
        this.minSwipeDistance = 50;
        this.swipeTimeLimit = 300;
        this.touchStartTime = 0;
        this.isSwiping = false;

        // PWA & オフライン対応
        this.setupOfflineHandling();

        // エラーハンドリング
        window.addEventListener('error', this.handleGlobalError.bind(this));
        window.addEventListener('unhandledrejection', this.handleGlobalError.bind(this));

        // 初期化
        this.init();
    }

    // ===== オフライン処理設定 =====
    setupOfflineHandling() {
        window.addEventListener('online', () => {
            this.isOnline = true;
            this.updateConnectionStatus();
            if (this.firebaseInitialized) {
                this.reconnectFirestore();
            }
        });

        window.addEventListener('offline', () => {
            this.isOnline = false;
            this.updateConnectionStatus();
        });

        this.updateConnectionStatus();
    }

    updateConnectionStatus() {
        const statusEl = document.getElementById('connectionStatus');
        const textEl = document.getElementById('connectionText');
        
        if (this.isOnline) {
            statusEl.className = 'connection-status online';
            textEl.textContent = 'オンライン';
            setTimeout(() => {
                statusEl.style.display = 'none';
            }, 2000);
        } else {
            statusEl.className = 'connection-status offline';
            textEl.textContent = 'オフライン';
            statusEl.style.display = 'block';
        }
    }

    // ===== 初期化処理 =====
    async init() {
        try {
            document.getElementById('loadingText').textContent = '初期化中...';

            // イベントリスナー設定（即座に）
            this.setupEventListeners();

            // ローカルデータを即座に読み込み
            this.loadLocalData();
            this.updateUI();

            // Firebase SDK の読み込み
            await this.waitForFirebaseSDK();
            
            // Firebase初期化
            if (typeof firebase !== 'undefined') {
                await this.initFirebase();
            }

            // URL パラメータをチェック
            this.checkUrlParams();

            // データロード完了
            this.dataLoadingComplete = true;
            this.handlePendingSharedNote();

            // ローディング完了
            document.getElementById('loadingText').textContent = '完了';
            
            setTimeout(() => {
                document.getElementById('loadingScreen').classList.add('hidden');
                // スワイプヒントを表示（モバイルのみ）
                if (window.innerWidth <= 768 && this.currentNote) {
                    this.showSwipeHint();
                }
            }, 300);

        } catch (error) {
            this.handleError(error, 'アプリの初期化に失敗しました');
            
            setTimeout(() => {
                document.getElementById('loadingScreen').classList.add('hidden');
            }, 500);
        }
    }

    // ===== Firebase SDK待機 =====
    async waitForFirebaseSDK() {
        return new Promise((resolve) => {
            let attempts = 0;
            const maxAttempts = 50; // 5秒間待機
            
            const checkFirebase = () => {
                attempts++;
                if (typeof firebase !== 'undefined') {
                    resolve();
                } else if (attempts >= maxAttempts) {
                    console.warn('Firebase SDK timeout');
                    resolve();
                } else {
                    setTimeout(checkFirebase, 100);
                }
            };
            
            checkFirebase();
        });
    }

    // ===== Firebase初期化 =====
    async initFirebase() {
        try {
            // Firebase設定の検証
            this.validateFirebaseConfig();

            firebase.initializeApp(this.firebaseConfig);
            this.auth = firebase.auth();
            this.db = firebase.firestore();
            this.storage = firebase.storage();
            
            this.firebaseInitialized = true;

            // 認証の永続化を設定
            await this.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

            // オフライン永続化
            await this.db.enablePersistence({ synchronizeTabs: true })
                .catch(err => console.log('Persistence error:', err));

            // 認証状態の監視
            this.auth.onAuthStateChanged(this.handleAuthStateChange.bind(this));

            // 接続テスト（非同期）
            this.testFirebaseConnection();
            
        } catch (error) {
            console.error("Firebase initialization failed", error);
            this.firebaseInitialized = false;
            this.showToast('オフラインモードで動作中', 'info');
        }
    }

    // ===== Firebase設定検証 =====
    validateFirebaseConfig() {
        const required = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
        const missing = required.filter(key => !this.firebaseConfig[key]);
        
        if (missing.length > 0) {
            throw new Error(`Missing Firebase config: ${missing.join(', ')}`);
        }
    }

    // ===== Firebase接続テスト =====
    async testFirebaseConnection() {
        if (!this.db || !this.firebaseInitialized) return;

        try {
            const testDoc = this.db.collection('_test_').doc('connection');
            await testDoc.get();
            console.log('Firebase connection verified');
        } catch (error) {
            console.log('Firebase connection test:', error.message);
        }
    }

    // ===== 認証処理（メールアドレス） =====
    showAuthModal() {
        document.getElementById('authModal').classList.add('active');
        document.getElementById('emailInput').focus();
    }

    closeAuthModal() {
        document.getElementById('authModal').classList.remove('active');
        document.getElementById('authForm').reset();
        this.clearAuthErrors();
    }

    toggleAuthMode(e) {
        if (e) e.preventDefault();
        
        const passwordInput = document.getElementById('passwordInput');
        
        if (this.isAuthMode === 'login') {
            this.isAuthMode = 'register';
            document.getElementById('authFormTitle').textContent = '新規登録';
            document.getElementById('authSubmitText').textContent = '登録';
            document.getElementById('authToggleText').textContent = 'すでにアカウントをお持ちの方は';
            document.getElementById('authToggleLink').textContent = 'ログイン';
            passwordInput.setAttribute('autocomplete', 'new-password');
        } else {
            this.isAuthMode = 'login';
            document.getElementById('authFormTitle').textContent = 'ログイン';
            document.getElementById('authSubmitText').textContent = 'ログイン';
            document.getElementById('authToggleText').textContent = 'アカウントをお持ちでない方は';
            document.getElementById('authToggleLink').textContent = '新規登録';
            passwordInput.setAttribute('autocomplete', 'current-password');
        }
        
        this.clearAuthErrors();
    }

    clearAuthErrors() {
        document.getElementById('emailError').classList.remove('active');
        document.getElementById('passwordError').classList.remove('active');
    }

    async handleAuthSubmit(e) {
        e.preventDefault();
        
        if (!this.auth || !this.firebaseInitialized) {
            this.showToast('認証サービスに接続できません', 'error');
            return;
        }

        if (!this.checkRateLimit('auth', 5, 60000)) {
            this.showToast('試行回数が多すぎます。しばらくお待ちください', 'error');
            return;
        }
        
        const email = document.getElementById('emailInput').value.trim();
        const password = document.getElementById('passwordInput').value;
        
        // バリデーション
        this.clearAuthErrors();
        let hasError = false;
        
        if (!this.validateEmail(email)) {
            this.showAuthError('emailError', '有効なメールアドレスを入力してください');
            hasError = true;
        }
        
        if (password.length < 6) {
            this.showAuthError('passwordError', 'パスワードは6文字以上で入力してください');
            hasError = true;
        }
        
        if (hasError) return;
        
        try {
            let userCredential;
            if (this.isAuthMode === 'login') {
                userCredential = await this.auth.signInWithEmailAndPassword(email, password);
            } else {
                userCredential = await this.auth.createUserWithEmailAndPassword(email, password);
                
                // 表示名を設定
                const displayName = email.split('@')[0];
                await userCredential.user.updateProfile({ displayName });
            }
            
            this.closeAuthModal();
            
        } catch (error) {
            this.handleAuthError(error);
        }
    }

    // Google認証処理
    async handleGoogleLogin() {
        if (!this.auth || !this.firebaseInitialized) {
            this.showToast('認証サービスに接続できません', 'error');
            return;
        }

        if (!this.checkRateLimit('auth', 5, 60000)) {
            this.showToast('試行回数が多すぎます', 'error');
            return;
        }

        try {
            const provider = new firebase.auth.GoogleAuthProvider();
            await this.auth.signInWithPopup(provider);
            this.closeAuthModal();
        } catch (error) {
            this.handleGoogleAuthError(error);
        }
    }

    handleGoogleAuthError(error) {
        let message = 'ログインに失敗しました';
        
        switch(error.code) {
            case 'auth/popup-closed-by-user':
                message = 'ログインがキャンセルされました';
                break;
            case 'auth/popup-blocked':
                message = 'ポップアップがブロックされました';
                break;
            case 'auth/network-request-failed':
                message = 'ネットワークエラーです';
                break;
            case 'auth/unauthorized-domain':
                message = 'このドメインは承認されていません';
                break;
        }
        
        this.showToast(message, 'error');
    }

    validateEmail(email) {
        const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return re.test(email);
    }

    showAuthError(elementId, message) {
        const errorEl = document.getElementById(elementId);
        errorEl.textContent = message;
        errorEl.classList.add('active');
    }

    handleAuthError(error) {
        let message = 'エラーが発生しました';
        
        switch(error.code) {
            case 'auth/user-not-found':
                this.showAuthError('emailError', 'ユーザーが見つかりません');
                break;
            case 'auth/wrong-password':
                this.showAuthError('passwordError', 'パスワードが間違っています');
                break;
            case 'auth/email-already-in-use':
                this.showAuthError('emailError', 'このメールアドレスは既に使用されています');
                break;
            case 'auth/weak-password':
                this.showAuthError('passwordError', 'パスワードが弱すぎます');
                break;
            case 'auth/invalid-email':
                this.showAuthError('emailError', '無効なメールアドレスです');
                break;
            case 'auth/network-request-failed':
                this.showToast('ネットワークエラーです', 'error');
                break;
            default:
                this.showToast(message, 'error');
        }
    }

    // ===== 認証状態変更処理 =====
    async handleAuthStateChange(user) {
        try {
            if (user) {
                await this.handleAuthSuccess(user);
            } else {
                this.handleAuthLogout();
            }
            
            this.dataLoadingComplete = true;
            this.handlePendingSharedNote();
            
        } catch (error) {
            this.handleError(error, '認証処理でエラーが発生しました');
        }
    }

    async handleAuthSuccess(user) {
        this.currentUser = {
            uid: user.uid,
            displayName: user.displayName || user.email.split('@')[0],
            email: user.email,
            photoURL: user.photoURL
        };
        
        await this.ensureUserDocument();
        await this.loadNotesFromFirestore();
        await this.loadReadingProgress();
        
        this.showToast('ログインしました', 'success');
    }

    handleAuthLogout() {
        this.cleanupListeners();
        
        this.currentUser = null;
        this.notesMap.clear();
        this.passwordCache.clear();
        
        const keys = Object.keys(localStorage);
        keys.forEach(key => {
            if (key.startsWith('studybook_')) {
                localStorage.removeItem(key);
            }
        });
        
        this.updateUI();
    }

    async handleLogout() {
        if (this.auth && this.firebaseInitialized) {
            try {
                await this.auth.signOut();
                this.showToast('ログアウトしました', 'info');
            } catch (error) {
                this.handleError(error, 'ログアウトに失敗しました');
            }
        } else {
            this.handleAuthLogout();
            this.showToast('ログアウトしました', 'info');
        }
    }

    async ensureUserDocument() {
        if (!this.db || !this.currentUser || !this.firebaseInitialized) return;
        
        try {
            const userDocRef = this.db.collection('users').doc(this.currentUser.uid);
            const userDoc = await userDocRef.get();
            
            if (!userDoc.exists) {
                await userDocRef.set({
                    displayName: this.currentUser.displayName,
                    email: this.currentUser.email,
                    photoURL: this.currentUser.photoURL,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            } else {
                await userDocRef.update({
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            }
        } catch (error) {
            console.error('Error ensuring user document:', error);
        }
    }

    // ===== 本棚UI =====
    setViewMode(mode) {
        this.viewMode = mode;
        
        if (mode === 'shelf') {
            document.getElementById('shelfViewBtn').classList.add('active');
            document.getElementById('gridViewBtn').classList.remove('active');
            document.getElementById('bookshelfView').style.display = 'block';
            document.getElementById('gridView').style.display = 'none';
            this.updateBookshelf();
        } else {
            document.getElementById('shelfViewBtn').classList.remove('active');
            document.getElementById('gridViewBtn').classList.add('active');
            document.getElementById('bookshelfView').style.display = 'none';
            document.getElementById('gridView').style.display = 'block';
            this.updateMyBooks();
        }
    }

    updateBookshelf() {
        if (!this.currentUser) return;
        
        const myNotes = Array.from(this.notesMap.values())
            .filter(n => n.authorId === this.currentUser.uid && !n.id.startsWith('public_'))
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        
        const shelfContainer = document.getElementById('myBookshelf');
        
        if (myNotes.length === 0) {
            shelfContainer.innerHTML = '<p style="color: var(--text-secondary); text-align: center; grid-column: 1/-1; padding: 2rem;">まだノートがありません</p>';
            return;
        }
        
        shelfContainer.innerHTML = myNotes.map((note, index) => {
            const hasPassword = note.password || note.visibility?.type === 'password';
            const lockIcon = hasPassword ? '<div class="book-spine-lock">🔐</div>' : '';
            
            return `
                <div class="book-spine" 
                     onclick="app.openBook('${note.id}', false)" 
                     title="${this.escapeHtml(note.title)}">
                    ${lockIcon}
                    <div class="book-spine-title">${this.escapeHtml(note.title)}</div>
                    <div class="book-spine-meta">${note.pages.length}P</div>
                </div>
            `;
        }).join('');
    }

    // ===== イベントリスナー設定（スワイプ機能追加） =====
    setupEventListeners() {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', this.debounce(this.handleSearch.bind(this), 300));
            document.addEventListener('click', (e) => {
                if (!searchInput.contains(e.target)) {
                    document.getElementById('searchResults').classList.remove('active');
                }
            });
        }

        document.addEventListener('change', (e) => {
            if (e.target.name === 'visibility') {
                this.toggleVisibilityOptions(e.target.value);
            }
        });

        // スワイプ機能の設定
        this.setupSwipeHandlers();

        // モーダル外クリックで閉じる
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal-overlay')) {
                if (e.target.id === 'authModal') {
                    this.closeAuthModal();
                } else if (e.target.id !== 'passwordPromptModal') {
                    e.target.classList.remove('active');
                }
            }
        });

        document.addEventListener('keydown', (e) => {
            if (this.currentNote) {
                if (e.key === 'ArrowLeft') this.previousPage();
                if (e.key === 'ArrowRight') this.nextPage();
                if (e.key === 'Escape') this.toggleSidebar();
            }

            if (e.key === 'Enter' && document.getElementById('passwordPromptModal').classList.contains('active')) {
                this.submitPassword();
            }
        });
    }

    // ===== スワイプ機能 =====
    setupSwipeHandlers() {
        const pageContent = document.getElementById('pageContent');
        if (!pageContent) return;

        // タッチ開始
        pageContent.addEventListener('touchstart', (e) => {
            this.touchStartX = e.touches[0].clientX;
            this.touchStartY = e.touches[0].clientY;
            this.touchStartTime = Date.now();
            this.isSwiping = false;
        }, { passive: true });

        // タッチ移動
        pageContent.addEventListener('touchmove', (e) => {
            if (!this.currentNote) return;

            const currentX = e.touches[0].clientX;
            const currentY = e.touches[0].clientY;
            const diffX = Math.abs(currentX - this.touchStartX);
            const diffY = Math.abs(currentY - this.touchStartY);

            // 水平方向のスワイプが優勢な場合
            if (diffX > diffY && diffX > 10) {
                this.isSwiping = true;
                // スクロールを防止
                if (diffX > 30) {
                    e.preventDefault();
                }
            }
        }, { passive: false });

        // タッチ終了
        pageContent.addEventListener('touchend', (e) => {
            if (!this.currentNote || !this.isSwiping) return;

            this.touchEndX = e.changedTouches[0].clientX;
            this.touchEndY = e.changedTouches[0].clientY;
            
            const swipeDistanceX = this.touchEndX - this.touchStartX;
            const swipeDistanceY = Math.abs(this.touchEndY - this.touchStartY);

            // 水平スワイプの判定
            if (Math.abs(swipeDistanceX) > this.minSwipeDistance && 
                swipeDistanceY < 100) {
                
                if (swipeDistanceX > 0) {
                    // 右スワイプ → 前のページ
                    this.previousPage();
                } else {
                    // 左スワイプ → 次のページ
                    this.nextPage();
                }
            }

            this.isSwiping = false;
        }, { passive: true });
    }

    // ===== スワイプヒント表示 =====
    showSwipeHint() {
        const hint = document.getElementById('swipeHint');
        if (hint && !localStorage.getItem('studybook_swipe_hint_shown')) {
            hint.style.opacity = '1';
            setTimeout(() => {
                hint.style.opacity = '0';
                localStorage.setItem('studybook_swipe_hint_shown', 'true');
            }, 3000);
        }
    }

    // ===== 進捗管理 =====
    async loadReadingProgress() {
        if (!this.currentUser) return;

        let latestProgress = null;

        if (this.db && this.firebaseInitialized) {
            try {
                const progressRef = this.db.collection('reading_progress').doc(`${this.currentUser.uid}_latest`);
                const progressDoc = await progressRef.get();
                
                if (progressDoc.exists) {
                    latestProgress = progressDoc.data();
                }
            } catch (error) {
                console.log('Progress not available');
            }
        }
        
        if (!latestProgress) {
            const keys = Object.keys(localStorage).filter(k => k.startsWith('studybook_progress_'));
            if (keys.length > 0) {
                const progresses = keys.map(k => JSON.parse(localStorage.getItem(k)));
                latestProgress = progresses.sort((a, b) => b.timestamp - a.timestamp)[0];
            }
        }

        if (latestProgress) {
            this.displayContinueReading(latestProgress);
        }
    }

    saveReadingProgress(noteId, pageIndex) {
        if (!this.currentUser || !noteId) return;

        const progress = {
            noteId,
            pageIndex,
            userId: this.currentUser.uid,
            timestamp: Date.now()
        };

        localStorage.setItem('studybook_progress_' + noteId, JSON.stringify(progress));

        if (this.db && this.firebaseInitialized) {
            this.db.collection('reading_progress')
                .doc(`${this.currentUser.uid}_latest`)
                .set(progress)
                .catch(() => {});

            this.db.collection('reading_progress')
                .doc(`${this.currentUser.uid}_${noteId}`)
                .set(progress)
                .catch(() => {});
        }
    }

    displayContinueReading(progress) {
        const note = this.findNoteById(progress.noteId);
        if (!note) return;

        const container = document.getElementById('continueReading');
        container.innerHTML = `
            <div class="continue-reading" onclick="app.openBook('${progress.noteId}', false); app.currentPage = ${progress.pageIndex}; app.updateViewer();">
                📖 続きから読む: ${this.escapeHtml(note.title)} (${progress.pageIndex + 1}/${note.pages.length}ページ)
            </div>
        `;
        container.style.display = 'block';
    }

    // ===== リアルタイムリスナー設定 =====
    setupRealtimeListeners() {
        if (!this.db || !this.currentUser || !this.firebaseInitialized) return;

        try {
            // 自分のノートのリスナー
            const myNotesRef = this.db.collection('users').doc(this.currentUser.uid).collection('notes');
            const myNotesQuery = myNotesRef.orderBy('updatedAt', 'desc').limit(50);
            
            const unsubscribeNotes = myNotesQuery.onSnapshot(
                (snapshot) => {
                    this.handleNotesSnapshot(snapshot, this.currentUser.uid);
                    this.reconnectAttempts = 0;
                },
                (error) => {
                    this.handleFirestoreError(error, 'notes');
                }
            );
            
            this.listeners.set('myNotes', unsubscribeNotes);
            
            // 公開ノートのリスナー
            const publicNotesQuery = this.db.collection('publicNotes')
                .orderBy('updatedAt', 'desc')
                .limit(20);
            
            const unsubscribePublicNotes = publicNotesQuery.onSnapshot(
                (snapshot) => {
                    this.handlePublicNotesSnapshot(snapshot);
                    this.reconnectAttempts = 0;
                },
                (error) => {
                    this.handleFirestoreError(error, 'publicNotes');
                }
            );
            
            this.listeners.set('publicNotes', unsubscribePublicNotes);
            
        } catch (error) {
            console.error('Error setting up listeners:', error);
        }
    }

    handleNotesSnapshot(snapshot, authorId) {
        let hasChanges = false;
        
        snapshot.docChanges().forEach((change) => {
            const noteData = { id: change.doc.id, ...change.doc.data(), authorId };
            
            if (change.type === 'added' || change.type === 'modified') {
                this.notesMap.set(change.doc.id, noteData);
                hasChanges = true;
            } else if (change.type === 'removed') {
                this.notesMap.delete(change.doc.id);
                hasChanges = true;
                
                if (this.currentNote && this.currentNote.id === change.doc.id) {
                    this.currentNote = null;
                    this.goHome();
                }
            }
        });
        
        if (hasChanges) {
            this.updateSearchIndex();
            this.updateUI();
            this.saveLocalData();
        }
    }

    handlePublicNotesSnapshot(snapshot) {
        let hasChanges = false;
        
        snapshot.docChanges().forEach((change) => {
            const noteData = { id: change.doc.id, ...change.doc.data() };
            
            if (noteData.authorId !== this.currentUser?.uid) {
                if (change.type === 'added' || change.type === 'modified') {
                    this.notesMap.set('public_' + change.doc.id, noteData);
                    hasChanges = true;
                } else if (change.type === 'removed') {
                    this.notesMap.delete('public_' + change.doc.id);
                    hasChanges = true;
                }
            }
        });
        
        if (hasChanges) {
            this.updateSearchIndex();
            this.updateUI();
        }
    }

    handleFirestoreError(error, listenerType) {
        console.log(`Firestore ${listenerType} listener warning:`, error.message);
        
        if (error.code === 'permission-denied') {
            if (this.notesMap.size === 0) {
                this.loadLocalData();
            }
        }
    }

    cleanupListeners() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        this.listeners.forEach((unsubscribe, key) => {
            try {
                unsubscribe();
            } catch (error) {
                console.warn(`Error cleaning up listener ${key}:`, error);
            }
        });
        this.listeners.clear();
    }

    // ===== 再接続処理 =====
    async reconnectFirestore() {
        if (!this.db || !this.isOnline || !this.firebaseInitialized) return;

        try {
            this.cleanupListeners();
            
            setTimeout(() => {
                if (this.currentUser) {
                    this.setupRealtimeListeners();
                    this.reconnectAttempts = 0;
                }
            }, 1000);
            
        } catch (error) {
            console.error('Reconnection error:', error);
        }
    }

    // ===== URL パラメータチェック =====
    checkUrlParams() {
        const urlParams = new URLSearchParams(window.location.search);
        const noteId = urlParams.get('book');

        if (noteId) {
            this.pendingSharedNoteId = noteId;
            
            if (this.dataLoadingComplete) {
                this.handlePendingSharedNote();
            }
        }
    }

    // ===== 共有ノート処理 =====
    async handlePendingSharedNote() {
        if (!this.pendingSharedNoteId || !this.dataLoadingComplete) {
            return;
        }

        const noteId = this.pendingSharedNoteId;
        this.pendingSharedNoteId = null;

        let note = this.findNoteById(noteId);

        if (note) {
            if (await this.checkPasswordProtection(note)) {
                this.openBook(noteId, false);
                return;
            } else {
                return;
            }
        }

        if (this.db && this.firebaseInitialized) {
            await this.loadPublicNoteDirectly(noteId);
        } else {
            this.showToast('オフラインでは共有ノートを開けません', 'error');
        }
    }

    // ===== パスワード保護チェック =====
    async checkPasswordProtection(note) {
        if (!note.password && note.visibility?.type !== 'password') {
            return true;
        }

        if (this.currentUser && note.authorId === this.currentUser.uid) {
            return true;
        }

        const cachedPassword = this.passwordCache.get(note.id);
        if (cachedPassword) {
            const correctPassword = note.password || note.visibility?.password;
            if (cachedPassword === correctPassword) {
                return true;
            }
        }

        this.pendingPasswordNote = note;
        this.showPasswordPrompt(note);
        return false;
    }

    showPasswordPrompt(note) {
        document.getElementById('passwordPromptInput').value = '';
        document.getElementById('passwordPromptModal').classList.add('active');
        setTimeout(() => {
            document.getElementById('passwordPromptInput').focus();
        }, 100);
    }

    async submitPassword() {
        const password = document.getElementById('passwordPromptInput').value.trim();
        
        if (!password) {
            this.showToast('パスワードを入力してください', 'warning');
            return;
        }

        if (!this.pendingPasswordNote) {
            this.closePasswordPrompt();
            return;
        }

        const correctPassword = this.pendingPasswordNote.password || 
                              this.pendingPasswordNote.visibility?.password;

        if (password === correctPassword) {
            this.passwordCache.set(this.pendingPasswordNote.id, password);
            this.closePasswordPrompt();
            this.openBook(this.pendingPasswordNote.id, false);
            this.pendingPasswordNote = null;
            this.showToast('パスワードが正しく入力されました', 'success');
        } else {
            this.showToast('パスワードが間違っています', 'error');
            document.getElementById('passwordPromptInput').value = '';
            document.getElementById('passwordPromptInput').focus();
        }
    }

    closePasswordPrompt() {
        document.getElementById('passwordPromptModal').classList.remove('active');
        this.pendingPasswordNote = null;
    }

    // ===== ノート検索 =====
    findNoteById(noteId) {
        return this.notesMap.get(noteId) || 
               this.notesMap.get('public_' + noteId) ||
               null;
    }

    // ===== 公開ノートを直接取得 =====
    async loadPublicNoteDirectly(noteId) {
        if (!this.db || !this.firebaseInitialized) {
            this.showToast('オフラインでは共有ノートを開けません', 'error');
            return;
        }
        
        try {
            const publicNoteRef = this.db.collection('publicNotes').doc(noteId);
            const publicNoteDoc = await publicNoteRef.get();
            
            if (publicNoteDoc.exists) {
                const noteData = { id: publicNoteDoc.id, ...publicNoteDoc.data() };
                
                if (noteData.isPublic || noteData.visibility?.type === 'password' || noteData.password) {
                    this.notesMap.set(noteId, noteData);
                    
                    if (await this.checkPasswordProtection(noteData)) {
                        this.openBook(noteId, false);
                    }
                    return;
                }
            }
            
            await this.findNoteInUserCollections(noteId);
            
        } catch (error) {
            this.handleError(error, '共有ノートの読み込みに失敗しました');
        }
    }

    // ===== ユーザーコレクションから検索 =====
    async findNoteInUserCollections(noteId) {
        try {
            const usersRef = this.db.collection('users');
            const usersSnapshot = await usersRef.limit(20).get();
            
            for (const userDoc of usersSnapshot.docs) {
                try {
                    const noteRef = this.db.collection('users').doc(userDoc.id).collection('notes').doc(noteId);
                    const noteSnapshot = await noteRef.get();
                    
                    if (noteSnapshot.exists) {
                        const noteData = { id: noteSnapshot.id, ...noteSnapshot.data(), authorId: userDoc.id };
                        
                        if (noteData.isPublic || noteData.visibility?.type === 'password' || noteData.password) {
                            this.notesMap.set(noteId, noteData);
                            
                            if (await this.checkPasswordProtection(noteData)) {
                                this.openBook(noteId, false);
                            }
                            return;
                        }
                    }
                } catch (userError) {
                    continue;
                }
            }
            
            this.showToast('共有ノートが見つからないか、アクセス権限がありません', 'error');
            
        } catch (error) {
            this.showToast('共有ノートの検索中にエラーが発生しました', 'error');
        }
    }

    // ===== データ読み込み =====
    async loadNotesFromFirestore() {
        if (!this.db || !this.currentUser || !this.firebaseInitialized) {
            this.loadLocalData();
            return;
        }

        try {
            const now = Date.now();
            if (now - this.lastFetchTime < this.cacheTimeout && this.notesMap.size > 0) {
                this.updateUI();
                return;
            }

            this.cleanupListeners();
            this.notesMap.clear();
            
            await this.loadNotesOnce();
            this.setupRealtimeListeners();
            
            this.lastFetchTime = now;
            
        } catch (error) {
            if (error.code === 'permission-denied') {
                console.log('Permission check - loading local data');
            } else {
                this.handleError(error, 'データの読み込みに失敗しました');
            }
            
            this.loadLocalData();
        }
    }

    // ===== 一度だけのデータ取得 =====
    async loadNotesOnce() {
        try {
            const myNotesRef = this.db.collection('users').doc(this.currentUser.uid).collection('notes');
            const myNotesQuery = myNotesRef.orderBy('updatedAt', 'desc').limit(50);
            const mySnapshot = await myNotesQuery.get();
            
            mySnapshot.forEach(doc => {
                const noteData = { id: doc.id, ...doc.data(), authorId: this.currentUser.uid };
                this.notesMap.set(doc.id, noteData);
            });

            const publicNotesQuery = this.db.collection('publicNotes')
                .orderBy('updatedAt', 'desc')
                .limit(20);
            const publicSnapshot = await publicNotesQuery.get();
            
            publicSnapshot.forEach(doc => {
                const noteData = { id: doc.id, ...doc.data() };
                if (noteData.authorId !== this.currentUser.uid) {
                    this.notesMap.set('public_' + doc.id, noteData);
                }
            });

            this.updateSearchIndex();
            this.updateUI();
            this.loadReadingProgress();
            
        } catch (error) {
            console.error('One-time load error:', error);
            throw error;
        }
    }

    // ===== ローカルデータ処理 =====
    loadLocalData() {
        try {
            const localNotes = localStorage.getItem('studybook_notes');
            if (localNotes) {
                const notes = JSON.parse(localNotes);
                notes.forEach(note => {
                    this.notesMap.set(note.id, note);
                });
            }
            this.updateSearchIndex();
            this.updateUI();
        } catch (error) {
            console.error('Error loading local data:', error);
        }
    }

    saveLocalData() {
        try {
            const notes = Array.from(this.notesMap.values());
            localStorage.setItem('studybook_notes', JSON.stringify(notes));
        } catch (error) {
            console.warn('Error saving local data:', error);
        }
    }

    // ===== 検索機能 =====
    updateSearchIndex() {
        const notes = Array.from(this.notesMap.values());
        
        if (typeof Fuse !== 'undefined' && notes.length > 0) {
            this.fuseInstance = new Fuse(notes, {
                keys: [
                    { name: 'title', weight: 0.3 },
                    { name: 'author', weight: 0.2 },
                    { name: 'tags', weight: 0.2 },
                    { name: 'pages.title', weight: 0.15 },
                    { name: 'pages.content', weight: 0.15 }
                ],
                threshold: 0.3,
                includeScore: true
            });
        }
    }

    handleSearch(event) {
        const query = event.target.value.trim();
        
        if (!query) {
            document.getElementById('searchResults').classList.remove('active');
            return;
        }

        if (!this.fuseInstance) {
            this.updateSearchIndex();
        }

        if (this.fuseInstance) {
            const results = this.fuseInstance.search(query).slice(0, 8);
            this.displaySearchResults(results);
        }
    }

    displaySearchResults(results) {
        const container = document.getElementById('searchResults');
        
        if (results.length === 0) {
            container.innerHTML = '<div class="search-result-item">検索結果がありません</div>';
        } else {
            container.innerHTML = results.map(result => {
                const note = result.item;
                const hasPassword = note.password || note.visibility?.type === 'password';
                const passwordIcon = hasPassword ? ' 🔐' : '';
                
                return `
                    <div class="search-result-item" onclick="app.openBook('${note.id}', false)">
                        <div style="font-weight: 500; margin-bottom: 0.25rem;">${this.escapeHtml(note.title)}${passwordIcon}</div>
                        <div style="font-size: 0.8rem; color: var(--text-secondary);">
                            ${this.escapeHtml(note.author)} • ${note.pages.length}ページ
                        </div>
                    </div>
                `;
            }).join('');
        }
        
        container.classList.add('active');
    }

    // ===== ノート作成 =====
    async createNewBook() {
        if (!this.currentUser) {
            this.showToast('ログインが必要です', 'warning');
            this.showAuthModal();
            return;
        }

        const newNote = {
            title: '新しいノート',
            author: this.currentUser.displayName,
            authorId: this.currentUser.uid,
            isPublic: false,
            visibility: { type: 'private' },
            tags: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            pages: [
                {
                    title: 'タイトルページ',
                    content: '# 新しいノート\n\n内容を入力してください',
                    image: null,
                    tags: []
                }
            ],
            views: 0,
            likes: 0
        };

        if (this.db && this.firebaseInitialized) {
            try {
                const noteToSave = {
                    ...newNote,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                };
                
                const notesRef = this.db.collection('users').doc(this.currentUser.uid).collection('notes');
                const docRef = await notesRef.add(noteToSave);
                newNote.id = docRef.id;
                
            } catch (error) {
                this.handleError(error, 'ノートの作成に失敗しました');
                return;
            }
        } else {
            newNote.id = 'note_' + Date.now();
        }

        this.notesMap.set(newNote.id, newNote);
        this.currentNote = newNote;
        this.saveLocalData();
        this.showToast('ノートを作成しました', 'success');
        this.openBook(newNote.id, true);
    }

    // ===== ノートを開く =====
    async openBook(noteId, editMode = false) {
        const note = this.findNoteById(noteId);
        
        if (!note) {
            this.showToast('ノートが見つかりません', 'error');
            return;
        }

        if (editMode && (!this.currentUser || note.authorId !== this.currentUser.uid)) {
            this.showToast('編集権限がありません', 'warning');
            editMode = false;
        }

        if (!editMode) {
            const hasAccess = await this.checkPasswordProtection(note);
            if (!hasAccess) {
                return;
            }
        }

        this.currentNote = note;
        this.currentPage = 0;
        this.isEditing = editMode;

        document.getElementById('homeView').style.display = 'none';
        document.getElementById('viewerContainer').style.display = 'block';

        if (!editMode && this.db && this.firebaseInitialized && this.currentNote.id) {
            this.incrementViews(noteId);
        }

        if (!editMode && this.currentUser) {
            this.saveReadingProgress(noteId, 0);
        }

        // スワイプヒント表示（モバイル）
        if (window.innerWidth <= 768 && !editMode) {
            this.showSwipeHint();
        }

        this.updateViewer();
        window.scrollTo(0, 0);
    }

    // ===== 統計 =====
    async incrementViews(noteId) {
        if (!this.db || !this.firebaseInitialized) return;

        try {
            const actualNoteId = noteId.startsWith('public_') ? noteId.replace('public_', '') : noteId;
            
            if (this.currentNote.authorId === this.currentUser?.uid) {
                await this.db.collection('users').doc(this.currentUser.uid).collection('notes').doc(actualNoteId).update({
                    views: firebase.firestore.FieldValue.increment(1)
                });
            } else {
                await this.db.collection('publicNotes').doc(actualNoteId).update({
                    views: firebase.firestore.FieldValue.increment(1)
                });
            }
        } catch (error) {
            console.error('View count error:', error);
        }
    }

    // ===== ビューアー更新 =====
    updateViewer() {
        if (!this.currentNote) return;

        const isOwner = this.currentUser && this.currentNote.authorId === this.currentUser.uid;
        document.getElementById('saveBtn').style.display = this.isEditing ? 'inline-flex' : 'none';
        document.getElementById('addPageBtn').style.display = this.isEditing ? 'inline-flex' : 'none';
        document.getElementById('deleteBookBtn').style.display = isOwner ? 'inline-flex' : 'none';
        document.getElementById('pageInfo').textContent = `${this.currentPage + 1} / ${this.currentNote.pages.length}`;
        
        const visibilityIcon = this.getVisibilityIcon();
        document.getElementById('visibilityBtn').textContent = visibilityIcon;
        document.getElementById('visibilityBtn').title = this.getVisibilityTitle();

        this.updateTOC();
        this.updatePageContent();
        this.updatePageNavigation();
    }

    getVisibilityIcon() {
        const type = this.getCurrentVisibilityType();
        switch (type) {
            case 'public': return '🌍';
            case 'password': return '🔐';
            case 'private':
            default: return '🔒';
        }
    }

    getVisibilityTitle() {
        const type = this.getCurrentVisibilityType();
        switch (type) {
            case 'public': return '完全公開';
            case 'password': return 'パスワード保護';
            case 'private':
            default: return '非公開';
        }
    }

    getCurrentVisibilityType() {
        if (!this.currentNote) return 'private';
        
        if (this.currentNote.visibility?.type) {
            return this.currentNote.visibility.type;
        }
        
        if (this.currentNote.password) {
            return 'password';
        }
        
        return this.currentNote.isPublic ? 'public' : 'private';
    }

    // ===== ページコンテンツ更新（画像表示修正） =====
    updatePageContent() {
        const page = this.currentNote.pages[this.currentPage];

        if (this.isEditing) {
            document.getElementById('viewMode').style.display = 'none';
            document.getElementById('editMode').style.display = 'block';

            const bookTitleSection = document.getElementById('bookTitleSection');
            if (this.currentPage === 0) {
                bookTitleSection.style.display = 'block';
                document.getElementById('bookTitleInput').value = this.currentNote.title || '';
            } else {
                bookTitleSection.style.display = 'none';
            }

            document.getElementById('pageTitleInput').value = page.title || '';
            document.getElementById('pageContentInput').value = page.content || '';
            document.getElementById('pageTagsInput').value = (page.tags || []).join(', ');

            if (page.image) {
                document.getElementById('imagePreview').innerHTML = `
                    <img src="${this.escapeHtml(page.image)}" style="max-width: 100%; height: auto; display: block; margin: 0 auto; border-radius: 6px;">
                    <button class="btn btn-danger" onclick="app.removeImage()" style="margin-top: 0.5rem;">削除</button>
                `;
            } else {
                document.getElementById('imagePreview').innerHTML = '';
            }
        } else {
            document.getElementById('viewMode').style.display = 'block';
            document.getElementById('editMode').style.display = 'none';

            document.getElementById('pageTitle').textContent = page.title || 'ページ' + (this.currentPage + 1);

            if (page.image) {
                const pageImage = document.getElementById('pageImage');
                pageImage.src = page.image;
                pageImage.style.display = 'block';
                // 画像サイズ制限を強制
                pageImage.style.maxWidth = '100%';
                pageImage.style.height = 'auto';
            } else {
                document.getElementById('pageImage').style.display = 'none';
            }

            // Markdown処理（画像サイズ制限付き）
            if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
                const cleanContent = DOMPurify.sanitize(page.content || '');
                let htmlContent = marked.parse(cleanContent);
                
                // すべての画像タグにスタイルを追加
                htmlContent = htmlContent.replace(
                    /<img([^>]*)>/gi,
                    '<img$1 style="max-width: 100%; height: auto; display: block; margin: 1rem auto; border-radius: 6px;">'
                );
                
                document.getElementById('pageBody').innerHTML = DOMPurify.sanitize(htmlContent);
            } else {
                document.getElementById('pageBody').textContent = page.content || '';
            }
        }
    }

    // ===== ページナビゲーション（スワイプ対応） =====
    previousPage() {
        if (this.currentNote && this.currentPage > 0) {
            if (this.isEditing) {
                this.saveCurrentPage();
            }
            this.currentPage--;
            this.updateViewer();
            this.animatePageTransition('right');
            if (this.currentNote) {
                this.saveReadingProgress(this.currentNote.id, this.currentPage);
            }
        } else if (this.currentPage === 0) {
            this.showToast('最初のページです', 'info');
        }
    }

    nextPage() {
        if (this.currentNote && this.currentPage < this.currentNote.pages.length - 1) {
            if (this.isEditing) {
                this.saveCurrentPage();
            }
            this.currentPage++;
            this.updateViewer();
            this.animatePageTransition('left');
            if (this.currentNote) {
                this.saveReadingProgress(this.currentNote.id, this.currentPage);
            }
        } else if (this.currentPage === this.currentNote.pages.length - 1) {
            this.showToast('最後のページです', 'info');
        }
    }

    animatePageTransition(direction) {
        const content = document.getElementById('pageContentWrapper');
        if (!content) return;

        content.style.opacity = '0';
        content.style.transform = direction === 'left' ? 'translateX(-20px)' : 'translateX(20px)';
        
        setTimeout(() => {
            content.style.transition = 'opacity 0.3s, transform 0.3s';
            content.style.opacity = '1';
            content.style.transform = 'translateX(0)';
        }, 50);
    }

    goToPage(pageIndex) {
        if (this.isEditing) {
            this.saveCurrentPage();
        }
        this.currentPage = pageIndex;
        this.updateViewer();
        this.saveReadingProgress(this.currentNote.id, pageIndex);
        this.toggleSidebar();
    }

    // ===== 保存処理 =====
    saveCurrentPage() {
        if (!this.isEditing) return;

        const page = this.currentNote.pages[this.currentPage];
        page.title = document.getElementById('pageTitleInput').value || 'ページ' + (this.currentPage + 1);
        page.content = document.getElementById('pageContentInput').value || '';
        
        const tagsInput = document.getElementById('pageTagsInput').value;
        page.tags = tagsInput ? tagsInput.split(',').map(tag => tag.trim()).filter(Boolean) : [];

        if (this.currentPage === 0) {
            const bookTitle = document.getElementById('bookTitleInput').value;
            if (bookTitle) {
                this.currentNote.title = bookTitle;
            }
        }
    }

    async saveBook() {
        if (!this.isEditing || !this.currentNote) return;

        this.saveCurrentPage();

        const allTags = new Set();
        this.currentNote.pages.forEach(page => {
            (page.tags || []).forEach(tag => allTags.add(tag));
        });
        this.currentNote.tags = Array.from(allTags);

        this.currentNote.updatedAt = new Date().toISOString();

        if (this.db && this.firebaseInitialized) {
            try {
                const noteToSave = {
                    ...this.currentNote,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                };
                
                await this.db.collection('users').doc(this.currentUser.uid).collection('notes').doc(this.currentNote.id).set(noteToSave);
                
                await this.syncToPublicNotes();
                
                this.showToast('保存しました', 'success');
            } catch (error) {
                this.handleError(error, '保存に失敗しました');
            }
        } else {
            this.showToast('ローカルに保存しました', 'info');
        }

        if (this.currentNote) {
            this.notesMap.set(this.currentNote.id, this.currentNote);
        }
        this.saveLocalData();
        this.updateUI();
    }

    // ===== 公開ノート同期 =====
    async syncToPublicNotes() {
        if (!this.db || !this.currentNote || !this.currentNote.id || !this.currentUser || !this.firebaseInitialized) {
            return;
        }
        
        try {
            const actualNoteId = this.currentNote.id.startsWith('public_') 
                ? this.currentNote.id.replace('public_', '') 
                : this.currentNote.id;
            
            const isPublicOrPassword = this.currentNote.isPublic || 
                                     this.currentNote.visibility?.type === 'password' ||
                                     this.currentNote.password;
            
            if (isPublicOrPassword) {
                const publicNoteData = {
                    ...this.currentNote,
                    id: actualNoteId,
                    authorId: this.currentUser.uid,
                    author: this.currentUser.displayName || 'ユーザー'
                };
                
                await this.db.collection('publicNotes').doc(actualNoteId).set(publicNoteData);
                
            } else {
                try {
                    await this.db.collection('publicNotes').doc(actualNoteId).delete();
                } catch (error) {
                    console.log('Public note not found for deletion');
                }
            }
        } catch (error) {
            console.error('Public notes sync error:', error);
        }
    }

    // ===== 公開設定 =====
    showVisibilitySettings() {
        if (!this.currentUser || !this.currentNote || this.currentNote.authorId !== this.currentUser.uid) {
            this.showToast('自分のノートのみ変更できます', 'warning');
            return;
        }

        const currentType = this.getCurrentVisibilityType();
        document.querySelector(`input[name="visibility"][value="${currentType}"]`).checked = true;
        
        if (currentType === 'password') {
            const password = this.currentNote.password || this.currentNote.visibility?.password || '';
            document.getElementById('passwordInput').value = password;
        }
        
        this.toggleVisibilityOptions(currentType);
        document.getElementById('visibilityModal').classList.add('active');
    }

    toggleVisibilityOptions(type) {
        const passwordSection = document.getElementById('passwordSection');
        
        if (type === 'password') {
            passwordSection.style.display = 'block';
        } else {
            passwordSection.style.display = 'none';
        }
    }

    async saveVisibilitySettings() {
        const selectedType = document.querySelector('input[name="visibility"]:checked')?.value;
        if (!selectedType) {
            this.showToast('公開設定を選択してください', 'warning');
            return;
        }

        if (selectedType === 'password') {
            const password = document.getElementById('passwordInput').value.trim();
            if (!password || password.length < 4) {
                this.showToast('パスワードは4文字以上で入力してください', 'warning');
                return;
            }
        }

        try {
            if (selectedType === 'password') {
                this.currentNote.visibility = {
                    type: 'password',
                    password: document.getElementById('passwordInput').value.trim()
                };
                this.currentNote.isPublic = false;
                this.currentNote.password = document.getElementById('passwordInput').value.trim();
            } else {
                this.currentNote.visibility = {
                    type: selectedType
                };
                delete this.currentNote.password;
                this.currentNote.isPublic = (selectedType === 'public');
            }

            this.currentNote.updatedAt = new Date().toISOString();

            if (this.db && this.firebaseInitialized) {
                await this.db.collection('users').doc(this.currentUser.uid).collection('notes').doc(this.currentNote.id).update({
                    visibility: this.currentNote.visibility,
                    isPublic: this.currentNote.isPublic,
                    password: this.currentNote.password || null,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                
                await this.syncToPublicNotes();
            }

            this.notesMap.set(this.currentNote.id, this.currentNote);
            this.saveLocalData();
            
            this.updateViewer();
            this.updateUI();
            
            this.closeVisibilityModal();
            
            const typeNames = {
                'private': '完全非公開',
                'public': '完全公開',
                'password': 'パスワード保護'
            };
            
            this.showToast(`${typeNames[selectedType]}に設定しました`, 'success');
            
        } catch (error) {
            this.handleError(error, '公開設定の保存に失敗しました');
        }
    }

    closeVisibilityModal() {
        document.getElementById('visibilityModal').classList.remove('active');
    }

    // ===== シェア機能 =====
    showShareModal() {
        if (!this.currentNote) return;

        const shareNoteId = this.currentNote.id.startsWith('public_') 
            ? this.currentNote.id.replace('public_', '') 
            : this.currentNote.id;
        
        const shareUrl = `${window.location.origin}${window.location.pathname}?book=${shareNoteId}`;
        document.getElementById('shareUrl').value = shareUrl;
        
        const hasPassword = this.currentNote.password || this.currentNote.visibility?.type === 'password';
        const passwordInfoDiv = document.getElementById('sharePasswordInfo');
        
        if (hasPassword) {
            const password = this.currentNote.password || this.currentNote.visibility?.password;
            passwordInfoDiv.style.display = 'block';
            document.getElementById('sharePasswordDisplay').textContent = password;
        } else {
            passwordInfoDiv.style.display = 'none';
        }
        
        document.getElementById('shareModal').classList.add('active');
    }

    closeShareModal() {
        document.getElementById('shareModal').classList.remove('active');
    }

    async copyShareUrl() {
        const shareUrl = document.getElementById('shareUrl').value;
        
        try {
            await navigator.clipboard.writeText(shareUrl);
            this.showToast('URLをコピーしました', 'success');
            this.closeShareModal();
        } catch {
            const input = document.getElementById('shareUrl');
            input.select();
            document.execCommand('copy');
            this.showToast('URLをコピーしました', 'success');
            this.closeShareModal();
        }
    }

    shareToTwitter() {
        const url = document.getElementById('shareUrl').value;
        const hasPassword = this.currentNote.password || this.currentNote.visibility?.type === 'password';
        const passwordNote = hasPassword ? '（パスワード保護）' : '';
        const text = `「${this.currentNote.title}」を読んでいます${passwordNote}`;
        window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank');
        this.closeShareModal();
    }

    shareToLine() {
        const url = document.getElementById('shareUrl').value;
        const hasPassword = this.currentNote.password || this.currentNote.visibility?.type === 'password';
        const passwordNote = hasPassword ? '（パスワード保護）' : '';
        const text = `「${this.currentNote.title}」${passwordNote}\n${url}`;
        window.open(`https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`, '_blank');
        this.closeShareModal();
    }

    shareToFacebook() {
        const url = document.getElementById('shareUrl').value;
        window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, '_blank');
        this.closeShareModal();
    }

    // ===== エディター機能 =====
    insertMarkdown(before, after) {
        const textarea = document.getElementById('pageContentInput');
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selectedText = textarea.value.substring(start, end);
        
        const replacement = before + selectedText + after;
        textarea.value = textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
        
        const newPos = start + before.length + selectedText.length;
        textarea.focus();
        textarea.setSelectionRange(newPos, newPos);
    }

    async insertImageInContent() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        
        input.onchange = async (event) => {
            const file = event.target.files[0];
            if (!file) return;

            if (file.size > 5 * 1024 * 1024) {
                this.showToast('画像は5MB以下にしてください', 'error');
                return;
            }

            try {
                let imageUrl;

                if (this.storage && this.firebaseInitialized) {
                    const storageRef = this.storage.ref(`images/${this.currentUser.uid}/${Date.now()}_${file.name}`);
                    const snapshot = await storageRef.put(file);
                    imageUrl = await snapshot.ref.getDownloadURL();
                } else {
                    imageUrl = await new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onload = (e) => resolve(e.target.result);
                        reader.readAsDataURL(file);
                    });
                }

                const textarea = document.getElementById('pageContentInput');
                const pos = textarea.selectionStart;
                const imageMarkdown = `![画像](${imageUrl})\n`;
                
                textarea.value = textarea.value.substring(0, pos) + imageMarkdown + textarea.value.substring(pos);
                textarea.focus();
                textarea.setSelectionRange(pos + imageMarkdown.length, pos + imageMarkdown.length);

                this.showToast('画像を挿入しました', 'success');
            } catch (error) {
                this.handleError(error, '画像の挿入に失敗しました');
            }
        };

        input.click();
    }

    // ===== 画像処理 =====
    async handleImageUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (file.size > 5 * 1024 * 1024) {
            this.showToast('画像は5MB以下にしてください', 'error');
            return;
        }

        if (!file.type.startsWith('image/')) {
            this.showToast('画像ファイルを選択してください', 'error');
            return;
        }

        try {
            let imageUrl;

            if (this.storage && this.firebaseInitialized) {
                const storageRef = this.storage.ref(`images/${this.currentUser.uid}/${Date.now()}_${file.name}`);
                const snapshot = await storageRef.put(file);
                imageUrl = await snapshot.ref.getDownloadURL();
            } else {
                imageUrl = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = (e) => resolve(e.target.result);
                    reader.readAsDataURL(file);
                });
            }

            this.currentNote.pages[this.currentPage].image = imageUrl;
            document.getElementById('imagePreview').innerHTML = `
                <img src="${this.escapeHtml(imageUrl)}" style="max-width: 100%; height: auto; display: block; margin: 0 auto; border-radius: 6px;">
                <button class="btn btn-danger" onclick="app.removeImage()" style="margin-top: 0.5rem;">削除</button>
            `;

            this.showToast('画像をアップロードしました', 'success');
        } catch (error) {
            this.handleError(error, '画像のアップロードに失敗しました');
        }
    }

    handleDrop(event) {
        event.preventDefault();
        event.target.style.borderColor = 'var(--border-color)';
        
        const files = event.dataTransfer.files;
        if (files.length > 0) {
            document.getElementById('imageInput').files = files;
            this.handleImageUpload({ target: { files } });
        }
    }

    removeImage() {
        this.currentNote.pages[this.currentPage].image = null;
        document.getElementById('imagePreview').innerHTML = '';
        this.showToast('画像を削除しました', 'info');
    }

    // ===== ページ管理 =====
    addPage() {
        if (!this.isEditing) return;

        this.saveCurrentPage();

        this.currentNote.pages.push({
            title: `ページ${this.currentNote.pages.length + 1}`,
            content: '',
            image: null,
            tags: []
        });

        this.currentPage = this.currentNote.pages.length - 1;
        this.updateViewer();
        this.showToast('新しいページを追加しました', 'success');
    }

    deletePage(index, event) {
        if (event) event.stopPropagation();
        if (!this.isEditing || this.currentNote.pages.length <= 1) {
            if (this.currentNote.pages.length <= 1) {
                this.showToast('最後のページは削除できません', 'warning');
            }
            return;
        }

        if (confirm('このページを削除しますか？')) {
            this.currentNote.pages.splice(index, 1);
            
            if (this.currentPage >= this.currentNote.pages.length) {
                this.currentPage = this.currentNote.pages.length - 1;
            } else if (this.currentPage > index) {
                this.currentPage--;
            }
            
            if (this.db && this.firebaseInitialized) {
                const noteToSave = {
                    ...this.currentNote,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                };
                
                this.db.collection('users').doc(this.currentUser.uid).collection('notes')
                    .doc(this.currentNote.id)
                    .set(noteToSave)
                    .then(() => this.syncToPublicNotes())
                    .catch(console.error);
            }
            
            this.notesMap.set(this.currentNote.id, this.currentNote);
            this.saveLocalData();
            
            this.updateViewer();
            this.showToast('ページを削除しました', 'info');
        }
    }

    // ===== ノート削除 =====
    async deleteBook() {
        if (!this.currentUser || !this.currentNote || this.currentNote.authorId !== this.currentUser.uid) {
            this.showToast('自分のノートのみ削除できます', 'warning');
            return;
        }

        if (!confirm(`「${this.currentNote.title}」を完全に削除しますか？この操作は取り消せません。`)) {
            return;
        }

        const noteId = this.currentNote.id;
        const isPublicOrPassword = this.currentNote.isPublic || 
                                 this.currentNote.visibility?.type === 'password' ||
                                 this.currentNote.password;

        try {
            this.currentNote = null;
            this.currentPage = 0;
            this.isEditing = false;
            this.goHome();

            if (this.db && this.firebaseInitialized) {
                await this.db.collection('users').doc(this.currentUser.uid).collection('notes').doc(noteId).delete();
                
                if (isPublicOrPassword) {
                    try {
                        await this.db.collection('publicNotes').doc(noteId).delete();
                    } catch (error) {
                        console.log('Public note deletion skipped:', error);
                    }
                }
            }

            this.notesMap.delete(noteId);
            this.notesMap.delete('public_' + noteId);
            this.passwordCache.delete(noteId);
            
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.includes(noteId)) {
                    keysToRemove.push(key);
                }
            }
            keysToRemove.forEach(key => localStorage.removeItem(key));
            
            this.saveLocalData();
            this.showToast('ノートを削除しました', 'success');
            this.updateUI();
        } catch (error) {
            this.handleError(error, 'ノートの削除に失敗しました');
        }
    }

    // ===== UI更新 =====
    updateUI() {
        this.updateAuthSection();
        this.updateMyBooks();
        this.updatePublicBooks();
        this.updateSearchIndex();
    }

    updateAuthSection() {
        const authSection = document.getElementById('authSection');
        if (this.currentUser) {
            authSection.innerHTML = `
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                    ${this.currentUser.photoURL ? 
                        `<img src="${this.escapeHtml(this.currentUser.photoURL)}" style="width: 28px; height: 28px; border-radius: 50%;" alt="プロフィール">` : 
                        `<div style="width: 28px; height: 28px; border-radius: 50%; background: var(--primary-color); display: flex; align-items: center; justify-content: center; color: white; font-size: 0.8rem; font-weight: 500;">${this.currentUser.displayName.charAt(0).toUpperCase()}</div>`
                    }
                    <span style="color: var(--text-primary); font-size: 0.9rem; font-weight: 500;">${this.escapeHtml(this.currentUser.displayName)}</span>
                    <button class="btn btn-secondary" onclick="app.handleLogout()" title="ログアウト">⏻</button>
                </div>
            `;
            document.getElementById('myBooksSection').style.display = 'block';
        } else {
            authSection.innerHTML = `
                <button class="btn btn-primary" onclick="app.showAuthModal()" title="ログイン">👤</button>
            `;
            document.getElementById('myBooksSection').style.display = 'none';
        }
    }

    updateMyBooks() {
        if (!this.currentUser) return;

        const myNotes = Array.from(this.notesMap.values())
            .filter(n => n.authorId === this.currentUser.uid && !n.id.startsWith('public_'))
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        if (this.viewMode === 'shelf') {
            this.updateBookshelf();
        }

        const container = document.getElementById('myBooksList');

        if (myNotes.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 2rem;">まだノートがありません</p>';
            return;
        }

        container.innerHTML = myNotes.map(note => this.createBookCard(note, true)).join('');
    }

    updatePublicBooks() {
        const publicNotes = Array.from(this.notesMap.values())
            .filter(n => (n.isPublic || n.visibility?.type === 'password' || n.password) && n.id.startsWith('public_'))
            .sort((a, b) => (b.views || 0) - (a.views || 0))
            .slice(0, 12);

        const container = document.getElementById('publicBooksList');
        
        if (publicNotes.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 2rem;">公開されているノートはありません</p>';
            return;
        }

        container.innerHTML = publicNotes.map(note => this.createBookCard(note, false)).join('');
    }

    createBookCard(note, isOwner) {
        const tags = (note.tags || []).slice(0, 3).map(tag => 
            `<span class="tag" onclick="event.stopPropagation(); app.searchByTag('${this.escapeHtml(tag)}')">${this.escapeHtml(tag)}</span>`
        ).join('');

        const noteId = note.id.startsWith('public_') ? note.id.replace('public_', '') : note.id;
        const hasPassword = note.password || note.visibility?.type === 'password';
        const passwordIcon = hasPassword ? '<div class="password-icon" title="パスワード保護">🔐</div>' : '';

        return `
            <div class="book-card">
                ${passwordIcon}
                <h3 style="font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem; line-height: 1.3;">${this.escapeHtml(note.title)}</h3>
                <div style="color: var(--text-secondary); margin-bottom: 0.25rem; font-size: 0.85rem;">
                    👤 ${this.escapeHtml(note.author)}
                </div>
                <div style="color: var(--text-secondary); margin-bottom: 0.25rem; font-size: 0.85rem;">
                    📝 ${note.pages.length}ページ • 👁️ ${note.views || 0}回
                </div>
                <div class="tags-container">${tags}</div>
                <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
                    <button class="btn btn-primary" onclick="app.openBook('${noteId}', false)" style="flex: 1; font-size: 0.9rem;">
                        読む
                    </button>
                    ${isOwner ? `
                        <button class="btn btn-secondary" onclick="app.openBook('${noteId}', true)" style="flex: 1; font-size: 0.9rem;">
                            編集
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }

    updateTOC() {
        const tocList = document.getElementById('tocList');
        if (!this.currentNote) return;
        
        const pageGroups = [];
        const groupSize = 10;
        
        for (let i = 0; i < this.currentNote.pages.length; i += groupSize) {
            const groupPages = this.currentNote.pages.slice(i, i + groupSize);
            pageGroups.push({
                title: `第${Math.floor(i / groupSize) + 1}章 (${i + 1}-${Math.min(i + groupSize, this.currentNote.pages.length)}ページ)`,
                startIndex: i,
                pages: groupPages
            });
        }

        tocList.innerHTML = pageGroups.map((group, groupIndex) => {
            const isCurrentGroup = this.currentPage >= group.startIndex && this.currentPage < group.startIndex + group.pages.length;
            const expandedClass = isCurrentGroup ? 'expanded' : '';
            const chevron = isCurrentGroup ? '▼' : '▶';
            
            const pagesHtml = group.pages.map((page, pageIndex) => {
                const actualPageIndex = group.startIndex + pageIndex;
                const activeClass = actualPageIndex === this.currentPage ? 'active' : '';
                
                return `
                    <div class="toc-page ${activeClass}" onclick="app.goToPage(${actualPageIndex})">
                        <span>${this.escapeHtml(page.title || 'ページ' + (actualPageIndex + 1))}</span>
                        ${this.isEditing && this.currentNote.pages.length > 1 ? `
                            <button class="btn btn-danger" onclick="app.deletePage(${actualPageIndex}, event)" style="padding: 0.2rem 0.4rem; font-size: 0.7rem; margin-left: 0.5rem;" title="削除">
                                ×
                            </button>
                        ` : ''}
                    </div>
                `;
            }).join('');

            return `
                <div class="toc-section">
                    <div class="toc-section-header" onclick="app.toggleTOCSection(${groupIndex})">
                        <span>${group.title}</span>
                        <span class="toc-chevron" id="chevron-${groupIndex}">${chevron}</span>
                    </div>
                    <div class="toc-section-content ${expandedClass}" id="section-${groupIndex}">
                        ${pagesHtml}
                    </div>
                </div>
            `;
        }).join('');
    }

    toggleTOCSection(groupIndex) {
        const section = document.getElementById(`section-${groupIndex}`);
        const chevron = document.getElementById(`chevron-${groupIndex}`);
        
        if (section.classList.contains('expanded')) {
            section.classList.remove('expanded');
            chevron.textContent = '▶';
        } else {
            section.classList.add('expanded');
            chevron.textContent = '▼';
        }
    }

    updatePageNavigation() {
        if (!this.currentNote) return;
        
        document.getElementById('prevBtn').disabled = this.currentPage === 0;
        document.getElementById('nextBtn').disabled = this.currentPage === this.currentNote.pages.length - 1;

        const dotsContainer = document.getElementById('pageDots');
        dotsContainer.innerHTML = this.currentNote.pages.map((_, index) => `
            <div class="page-dot ${index === this.currentPage ? 'active' : ''}"
                 onclick="app.goToPage(${index})"
                 title="ページ${index + 1}"></div>
        `).join('');
    }

    // ===== その他の機能 =====
    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.toggle('open');
    }

    goHome() {
        if (this.isEditing && this.currentNote) {
            if (confirm('変更を保存しますか？')) {
                this.saveBook();
            }
        }

        document.getElementById('homeView').style.display = 'block';
        document.getElementById('viewerContainer').style.display = 'none';
        document.getElementById('sidebar').classList.remove('open');
        this.currentNote = null;
        this.currentPage = 0;
        this.isEditing = false;
        this.updateUI();
    }

    showPublicBooks() {
        document.getElementById('publicBooksSection').style.display = 'block';
        document.getElementById('publicBooksSection').scrollIntoView({ behavior: 'smooth' });
    }

    showPopularTags() {
        const tagCount = new Map();
        
        Array.from(this.notesMap.values()).forEach(note => {
            (note.tags || []).forEach(tag => {
                tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
            });
        });

        const popularTags = Array.from(tagCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15);

        const container = document.getElementById('popularTagsList');
        container.innerHTML = popularTags.map(([tag, count]) => 
            `<span class="tag" onclick="app.searchByTag('${this.escapeHtml(tag)}')" style="font-size: ${Math.min(1.2, 0.75 + count * 0.05)}rem;">
                ${this.escapeHtml(tag)} (${count})
            </span>`
        ).join('');

        document.getElementById('popularTagsSection').style.display = 'block';
        document.getElementById('popularTagsSection').scrollIntoView({ behavior: 'smooth' });
    }

    searchByTag(tag) {
        document.getElementById('searchInput').value = tag;
        this.handleSearch({ target: { value: tag } });
        document.getElementById('searchInput').scrollIntoView({ behavior: 'smooth' });
    }

    // ===== ユーティリティ =====
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    checkRateLimit(action, maxAttempts, timeWindow) {
        const now = Date.now();
        const key = `${action}_${this.currentUser?.uid || 'anonymous'}`;
        
        if (!this.rateLimiter.has(key)) {
            this.rateLimiter.set(key, []);
        }
        
        const attempts = this.rateLimiter.get(key);
        const recentAttempts = attempts.filter(timestamp => now - timestamp < timeWindow);
        
        if (recentAttempts.length >= maxAttempts) {
            return false;
        }
        
        recentAttempts.push(now);
        this.rateLimiter.set(key, recentAttempts);
        return true;
    }

    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast ${type} show`;
        
        setTimeout(() => {
            toast.classList.remove('show');
        }, 2500);
    }

    // ===== エラーハンドリング =====
    handleError(error, userMessage) {
        console.error(error);
        this.showToast(userMessage || 'エラーが発生しました', 'error');
    }

    handleGlobalError(event) {
        console.error('Global error:', event);
    }
}

// ===== アプリケーション起動 =====
let app;

function initializeApp() {
    try {
        app = new StudyBookApp();
        window.app = app;
        console.log('App initialized successfully');
    } catch (error) {
        console.error('App initialization error:', error);
    }
}

// DOMContentLoaded後に起動
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
