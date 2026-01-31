// ===== StudyBook Application - 完全版（スワイプ機能・画像修正付き） =====

class StudyBookApp {
    constructor() {
        // Firebase設定を環境変数から取得
        this.firebaseConfig = getFirebaseConfig();

        // 状態管理
        this.currentUser = null;
        this.notesMap = new Map();
        this.currentNote = null;
        this.currentPage = 0;
        this.currentShelfPage = 1;
        this.publicNotes = [];
        this.isEditing = false;
        this.isOnline = navigator.onLine;
        this.isAuthMode = 'login';
        this.displayMode = 'shelf';

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

        // 慣性スクロール用
        this.inertiaAnimationId = null;

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
            console.error('初期化エラー:', error);
            this.showToast('初期化に失敗しました。ローカル機能のみ利用可能です。', 'warning');

            // エラー時でもローカル機能は使用可能
            setTimeout(() => {
                document.getElementById('loadingScreen').classList.add('hidden');
            }, 500);
        }
    }


    // 外部ライブラリの動的読み込み
    async loadLibrary(url, globalVariable) {
        return new Promise((resolve, reject) => {
            // 既に読み込まれている場合はスキップ
            if (typeof window[globalVariable] !== 'undefined') {
                resolve(window[globalVariable]);
                return;
            }

            const script = document.createElement('script');
            script.src = url;
            script.onload = () => resolve(window[globalVariable]);
            script.onerror = () => reject(new Error(`Failed to load ${url}`));
            document.head.appendChild(script);
        });
    }

    // Marked.js（Markdown処理）の動的読み込み
    async ensureMarkedLoaded() {
        if (typeof marked === 'undefined') {
            try {
                await this.loadLibrary('https://cdn.jsdelivr.net/npm/marked/marked.min.js', 'marked');
            } catch (error) {
                console.error('Marked.js の読み込みに失敗:', error);
                return false;
            }
        }
        return true;
    }

    // DOMPurify（サニタイズ）の動的読み込み
    async ensureDOMPurifyLoaded() {
        if (typeof DOMPurify === 'undefined') {
            try {
                await this.loadLibrary('https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js', 'DOMPurify');
            } catch (error) {
                console.error('DOMPurify の読み込みに失敗:', error);
                return false;
            }
        }
        return true;
    }

    // Fuse.js（検索エンジン）の動的読み込み
    async ensureFuseLoaded() {
        if (typeof Fuse === 'undefined') {
            try {
                await this.loadLibrary('https://cdn.jsdelivr.net/npm/fuse.js@6.6.2', 'Fuse');
            } catch (error) {
                console.error('Fuse.js の読み込みに失敗:', error);
                return false;
            }
        }
        return true;
    }

    // Markdownコンテンツのレンダリング（動的読み込み対応）
    async renderMarkdownContent(content) {
        const pageBodyEl = document.getElementById('pageBody');

        try {
            // ライブラリを並行して読み込み
            const [markedLoaded, domPurifyLoaded] = await Promise.all([
                this.ensureMarkedLoaded(),
                this.ensureDOMPurifyLoaded()
            ]);

            if (markedLoaded && domPurifyLoaded) {
                let cleanContent = DOMPurify.sanitize(content);

                // Markdownパースの前に改行を保持するための処理
                cleanContent = cleanContent.replace(/\n\s*\n/g, '\n\n');
                cleanContent = cleanContent.replace(/([^\n])\n([^\n])/g, '$1  \n$2');

                let htmlContent = marked.parse(cleanContent);

                // すべての画像タグにスタイルを追加
                htmlContent = htmlContent.replace(
                    /<img([^>]*)>/gi,
                    '<img$1 style="max-width: 100%; height: auto; display: block; margin: 1rem auto; border-radius: 6px;">'
                );

                pageBodyEl.innerHTML = DOMPurify.sanitize(htmlContent);
            } else {
                throw new Error('Markdown libraries failed to load');
            }
        } catch (error) {
            console.error('Markdown処理エラー:', error);
            // フォールバック：プレーンテキスト表示
            pageBodyEl.innerHTML = '';
            const preEl = document.createElement('pre');
            preEl.style.cssText = 'white-space: pre-wrap; word-wrap: break-word; font-family: inherit; margin: 0; line-height: 1.4;';
            preEl.textContent = content;
            pageBodyEl.appendChild(preEl);
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
                    console.log('Firebase SDK loaded successfully');
                    resolve();
                } else if (attempts >= maxAttempts) {
                    console.warn('Firebase SDK timeout');
                    resolve();
                } else {
                    setTimeout(checkFirebase, 100);
                }
            };
            
            // 初回チェックを少し遅延
            setTimeout(checkFirebase, 500);
        });
    }

    // ===== Firebase初期化 =====
    async initFirebase() {
        try {
            // SDKの確認
            if (typeof firebase === 'undefined') {
                console.error('Firebase SDK not loaded');
                this.showToast('Firebase SDKの読み込みに失敗しました', 'error');
                return;
            }

            // Firebase設定の検証
            this.validateFirebaseConfig();

            // Firebase初期化
            if (!firebase.apps.length) {
                firebase.initializeApp(this.firebaseConfig);
                console.log('Firebase initialized with config:', this.firebaseConfig.projectId);
            } else {
                console.log('Firebase already initialized');
            }
            
            this.auth = firebase.auth();
            this.db = firebase.firestore();
            this.storage = firebase.storage();

            // 認証の言語を日本語に設定
            this.auth.languageCode = 'ja';

            this.firebaseInitialized = true;
            console.log('Firebase services initialized');

            // 認証の永続化を設定
            try {
                await this.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
                console.log('Auth persistence set');
            } catch (persistError) {
                console.warn('Auth persistence error:', persistError);
            }

            // Firestoreオフライン永続化
            try {
                await this.db.enablePersistence({ synchronizeTabs: true });
                console.log('Firestore persistence enabled');
            } catch (err) {
                if (err.code === 'failed-precondition') {
                    console.log('Multiple tabs open, persistence can only be enabled in one tab at a time.');
                } else if (err.code === 'unimplemented') {
                    console.log('The current browser does not support offline persistence');
                }
            }

            // 認証状態の監視
            this.auth.onAuthStateChanged(this.handleAuthStateChange.bind(this));
            console.log('Auth state listener attached');

            // パスワードリセット完了の確認
            this.checkPasswordResetCompletion();

            // 接続テスト（非同期）
            setTimeout(() => {
                this.testFirebaseConnection();
            }, 1000);
            
        } catch (error) {
            console.error("Firebase initialization failed:", error);
            this.firebaseInitialized = false;
            this.showToast('Firebase初期化エラー: ' + error.message, 'error');
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
        this.isAuthMode = 'login';
        document.getElementById('authModal').classList.add('active');
        document.getElementById('emailInput').focus();

        // パスワードリセットリンクをログイン時のみ表示
        const passwordResetLink = document.getElementById('passwordResetLink');
        if (passwordResetLink) {
            passwordResetLink.style.display = 'block';
        }
    }

    closeAuthModal() {
        document.getElementById('authModal').classList.remove('active');
        document.getElementById('authForm').reset();
        this.clearAuthErrors();
    }

    toggleAuthMode(e) {
        if (e) e.preventDefault();

        const passwordInput = document.getElementById('passwordInput');
        const passwordResetLink = document.getElementById('passwordResetLink');

        if (this.isAuthMode === 'login') {
            this.isAuthMode = 'register';
            document.getElementById('authFormTitle').textContent = '新規登録';
            document.getElementById('authSubmitText').textContent = '登録';
            document.getElementById('authToggleText').textContent = 'すでにアカウントをお持ちの方は';
            document.getElementById('authToggleLink').textContent = 'ログイン';
            passwordInput.setAttribute('autocomplete', 'new-password');
            passwordResetLink.style.display = 'none'; // 新規登録時は非表示
        } else {
            this.isAuthMode = 'login';
            document.getElementById('authFormTitle').textContent = 'ログイン';
            document.getElementById('authSubmitText').textContent = 'ログイン';
            document.getElementById('authToggleText').textContent = 'アカウントをお持ちでない方は';
            document.getElementById('authToggleLink').textContent = '新規登録';
            passwordInput.setAttribute('autocomplete', 'current-password');
            passwordResetLink.style.display = 'block'; // ログイン時は表示
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
            this.showToast('認証サービスに接続できません。ページを再読み込みしてください。', 'error');
            console.error('Auth not initialized. Auth:', !!this.auth, 'Firebase:', this.firebaseInitialized);
            return;
        }

        if (!this.checkRateLimit('auth', 5, 60000)) {
            this.showToast('試行回数が多すぎます', 'error');
            return;
        }

        try {
            const provider = new firebase.auth.GoogleAuthProvider();
            console.log('Google provider created');
            
            const result = await this.auth.signInWithPopup(provider);
            console.log('Google sign-in successful');
            
            this.closeAuthModal();
        } catch (error) {
            console.error('Google auth error:', error);
            this.handleGoogleAuthError(error);
        }
    }

    handleGoogleAuthError(error) {
        let message = 'ログインに失敗しました';
        
        console.error('Google auth error details:', error);
        
        switch(error.code) {
            case 'auth/popup-closed-by-user':
                message = 'ログインがキャンセルされました';
                break;
            case 'auth/popup-blocked':
                message = 'ポップアップがブロックされました。ブラウザの設定を確認してください';
                break;
            case 'auth/network-request-failed':
                message = 'ネットワークエラーです。接続を確認してください';
                break;
            case 'auth/unauthorized-domain':
                message = 'このドメインは承認されていません。Firebase Consoleで承認済みドメインに追加してください';
                console.error('Add domain to Firebase Console > Authentication > Settings > Authorized domains');
                break;
            case 'auth/operation-not-allowed':
                message = 'Google認証が無効です。Firebase ConsoleでGoogle認証を有効化してください';
                console.error('Enable Google Auth in Firebase Console > Authentication > Sign-in method');
                break;
            case 'auth/invalid-api-key':
                message = 'APIキーが無効です。Firebase設定を確認してください';
                break;
            case 'auth/configuration-not-found':
                message = 'Firebase設定が見つかりません';
                break;
            default:
                message = `エラー: ${error.code || error.message}`;
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
                this.showAuthError('passwordError', 'パスワードが正しくありません');
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
        this.displayMode = mode;

        // ホーム画面のフッターボタン更新
        const homeShelfBtn = document.getElementById('homeShelfBtn');

        if (homeShelfBtn) {
            if (mode === 'shelf') {
                homeShelfBtn.style.background = '#f5f5f5';
                homeShelfBtn.style.color = 'var(--text-primary)';
                document.getElementById('bookshelfView').style.display = 'block';
                document.getElementById('gridView').style.display = 'none';
                this.updateBookshelf();
            } else {
                homeShelfBtn.style.background = 'none';
                homeShelfBtn.style.color = 'var(--text-secondary)';
                document.getElementById('bookshelfView').style.display = 'none';
                document.getElementById('gridView').style.display = 'block';
                this.updateMyBooks();
            }
        }
    }

    updateBookshelf() {
        if (!this.currentUser) return;

        const myNotes = Array.from(this.notesMap.values())
            .filter(n => n.authorId === this.currentUser.uid && !n.id.startsWith('public_'))
            .sort((a, b) => this.compareJapanese(a, b));
        
        const shelfContainer = document.getElementById('myBookshelf');
        
        if (myNotes.length === 0) {
            shelfContainer.innerHTML = '<p style="color: var(--text-secondary); text-align: center; grid-column: 1/-1; padding: 2rem;">まだノートがありません</p>';
            return;
        }
        
        shelfContainer.innerHTML = myNotes.map((note, index) => {
            const hasPassword = note.password || note.visibility?.type === 'password';
            const lockIcon = hasPassword ? '<div class="book-spine-lock">🔐</div>' : '';
            const bookColor = note.bookColor || '#f8f8f8';
            const borderColor = this.getBorderColorFromBackground(bookColor);

            return `
                <div class="book-spine"
                     onclick="app.openBook('${note.id}', false)"
                     title="${this.escapeHtml(note.title)}"
                     style="background: ${bookColor}; border-color: ${borderColor};">
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

        // キーボード操作の設定
        this.setupKeyboardHandlers();

        // ドラッグ&ドロップ機能の設定
        this.setupDragAndDrop();

        // 色選択機能の設定
        this.setupColorPicker();

        // サイドバー外クリックで閉じる機能
        this.setupSidebarClickOutside();

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

    }

    // ===== キーボード操作機能 =====
    setupKeyboardHandlers() {
        document.addEventListener('keydown', (e) => {
            // フォーカスが入力欄にある場合は操作を無効化
            const activeElement = document.activeElement;
            const isInputActive = activeElement && (
                activeElement.tagName === 'INPUT' ||
                activeElement.tagName === 'TEXTAREA' ||
                activeElement.contentEditable === 'true'
            );

            // モーダルが開いている場合の特別処理
            if (document.getElementById('passwordPromptModal').classList.contains('active')) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.submitPassword();
                }
                return;
            }

            // ヘルプモーダルの表示/非表示
            if (e.key === '?' && !isInputActive) {
                e.preventDefault();
                this.toggleKeyboardHelp();
                return;
            }

            // ESCキーでモーダルやサイドバーを閉じる
            if (e.key === 'Escape') {
                e.preventDefault();
                if (document.getElementById('shareModal').classList.contains('active')) {
                    this.closeShareModal();
                } else if (document.getElementById('visibilityModal').classList.contains('active')) {
                    this.closeVisibilityModal();
                } else if (document.getElementById('keyboardHelpModal') && document.getElementById('keyboardHelpModal').classList.contains('active')) {
                    this.closeKeyboardHelp();
                } else {
                    this.toggleSidebar();
                }
                return;
            }

            // ビューアーが開いている場合のページ操作
            if (this.currentNote && !isInputActive) {
                switch(e.key) {
                    case 'ArrowLeft':
                    case 'h':
                        e.preventDefault();
                        this.previousPage();
                        break;
                    case 'ArrowRight':
                    case 'l':
                        e.preventDefault();
                        this.nextPage();
                        break;
                    case 'ArrowUp':
                    case 'k':
                        e.preventDefault();
                        this.previousPage();
                        break;
                    case 'ArrowDown':
                    case 'j':
                        e.preventDefault();
                        this.nextPage();
                        break;
                    case 'Home':
                        e.preventDefault();
                        this.goToPage(0);
                        break;
                    case 'End':
                        e.preventDefault();
                        this.goToPage(this.currentNote.pages.length - 1);
                        break;
                    case 'e':
                        e.preventDefault();
                        this.toggleEdit();
                        break;
                    case 's':
                        if (e.ctrlKey || e.metaKey) {
                            e.preventDefault();
                            this.saveBook();
                        }
                        break;
                    case 'm':
                        e.preventDefault();
                        this.toggleSidebar();
                        break;
                }
            }

            // ホーム画面での操作
            if (!this.currentNote && !isInputActive) {
                switch(e.key) {
                    case 'n':
                        e.preventDefault();
                        this.createNewBook();
                        break;
                    case '/':
                        e.preventDefault();
                        document.getElementById('searchInput').focus();
                        break;
                }
            }
        });
    }


    // 編集モードの切り替え
    toggleEdit() {
        console.log('toggleEdit called');
        console.log('  currentNote:', this.currentNote ? 'exists' : 'null');
        console.log('  currentUser:', this.currentUser ? 'exists' : 'null');
        console.log('  isEditing before:', this.isEditing);

        if (!this.currentNote) {
            console.log('  ERROR: No currentNote');
            return;
        }
        if (!this.currentUser) {
            console.log('  ERROR: No currentUser');
            return;
        }

        if (this.isEditing) {
            console.log('  Switching to VIEW mode');
            this.viewMode();
        } else {
            console.log('  Switching to EDIT mode');
            this.editMode();
        }
        console.log('  isEditing after:', this.isEditing);
    }

    // 編集モードに切り替え
    editMode() {
        console.log('editMode() called');
        this.isEditing = true;
        const editBtn = document.getElementById('editToggleBtn');
        console.log('  editBtn found:', editBtn ? 'yes' : 'no');
        if (editBtn) {
            editBtn.textContent = '👁️';
            editBtn.title = '閲覧モード (e)';
            editBtn.className = 'btn btn-primary';
            console.log('  Button changed to 👁️');
        }
        this.updateViewer();
    }

    // 閲覧モードに切り替え
    viewMode() {
        console.log('viewMode() called');
        if (this.isEditing) {
            const shouldSave = confirm('保存しますか？');
            console.log('  shouldSave:', shouldSave);
            if (shouldSave) {
                this.saveCurrentPage();
                this.saveBook();
                this.showToast('保存しました', 'success');
            }
        }
        this.isEditing = false;
        const editBtn = document.getElementById('editToggleBtn');
        console.log('  editBtn found:', editBtn ? 'yes' : 'no');
        if (editBtn) {
            editBtn.textContent = '✏️';
            editBtn.title = '編集 (e)';
            editBtn.className = 'btn btn-secondary';
            console.log('  Button changed to ✏️');
        }
        this.updateViewer();
    }

    // ===== スワイプ機能（改善版：限定領域＋ズーム分離） =====
setupSwipeHandlers() {
    // ページコンテンツ内でのみスワイプを有効にする（より限定的に）
    const viewMode = document.getElementById('viewMode');
    const editMode = document.getElementById('editMode');

    if (!viewMode || !editMode) return;

    // スワイプ検出の閾値設定
    this.swipeThreshold = {
        distance: 80,      // 最小スワイプ距離（増加）
        velocity: 0.3,     // 最小速度
        maxVertical: 50,   // 縦方向の最大許容移動
        timeLimit: 500     // 最大時間
    };

    // 閲覧モードでのみスワイプを有効にする（より安全）
    const setupSwipeForElement = (element) => {
        // タッチ開始
        element.addEventListener('touchstart', (e) => {
            // 編集モード中でも、入力フィールド外ではスワイプを許可
            const target = e.target;
            if (this.isEditing && (
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'INPUT' ||
                target.closest('textarea') ||
                target.closest('input')
            )) {
                this.isSwiping = false;
                return;
            }

            // マルチタッチ（ズーム操作）の場合はスワイプを無効化
            if (e.touches.length > 1) {
                this.isSwiping = false;
                this.isMultiTouch = true;
                return;
            }

            // クリック可能な要素上では無効化
            if (target.tagName === 'BUTTON' ||
                target.tagName === 'A' ||
                target.onclick ||
                target.closest('button') ||
                target.closest('a')) {
                this.isSwiping = false;
                return;
            }

            this.touchStartX = e.touches[0].clientX;
            this.touchStartY = e.touches[0].clientY;
            this.touchStartTime = Date.now();
            this.isSwiping = false;
            this.isMultiTouch = false;
            this.swipeStarted = false;
        }, { passive: true });

        // タッチ移動
        element.addEventListener('touchmove', (e) => {
            if (!this.currentNote || this.isMultiTouch) return;

            // 編集モード中の入力フィールド内では無効化
            const target = e.target;
            if (this.isEditing && (
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'INPUT' ||
                target.closest('textarea') ||
                target.closest('input')
            )) {
                return;
            }

            // マルチタッチ（ズーム操作）の場合は無効化
            if (e.touches.length > 1) {
                this.isSwiping = false;
                this.isMultiTouch = true;
                return;
            }

            const currentX = e.touches[0].clientX;
            const currentY = e.touches[0].clientY;
            const diffX = currentX - this.touchStartX;
            const diffY = Math.abs(currentY - this.touchStartY);

            // 縦方向の移動が多い場合は縦スクロールと判定
            if (diffY > this.swipeThreshold.maxVertical) {
                this.isSwiping = false;
                return;
            }

            // 水平方向の移動が閾値を超えた場合にスワイプ開始
            const absDiffX = Math.abs(diffX);
            if (absDiffX > 30 && !this.swipeStarted) {
                this.swipeStarted = true;
                this.isSwiping = true;

                // 視覚的フィードバック（viewModeのみ）
                if (element.id === 'viewMode') {
                    element.style.transform = `translateX(${diffX * 0.05}px)`;
                    element.style.transition = 'none';
                }
            }

            // スワイプ中の場合のみ既定のスクロール動作を防止（縦スクロールは許可）
            if (this.isSwiping && this.swipeStarted) {
                e.preventDefault();
            }
        }, { passive: false });

        // タッチ終了
        element.addEventListener('touchend', (e) => {
            // 視覚的フィードバックをリセット
            if (element.id === 'viewMode') {
                element.style.transform = '';
                element.style.transition = 'transform 0.2s ease';
            }

            if (!this.currentNote || !this.isSwiping || this.isMultiTouch) {
                this.isSwiping = false;
                this.isMultiTouch = false;
                return;
            }

            this.touchEndX = e.changedTouches[0].clientX;
            this.touchEndY = e.changedTouches[0].clientY;

            const swipeDistanceX = this.touchEndX - this.touchStartX;
            const swipeDistanceY = Math.abs(this.touchEndY - this.touchStartY);
            const swipeTime = Date.now() - this.touchStartTime;
            const velocity = Math.abs(swipeDistanceX) / swipeTime;

            // 改善されたスワイプ判定
            const isValidSwipe = Math.abs(swipeDistanceX) > this.swipeThreshold.distance &&
                               swipeDistanceY < this.swipeThreshold.maxVertical &&
                               velocity > this.swipeThreshold.velocity &&
                               swipeTime < this.swipeThreshold.timeLimit;

            if (isValidSwipe) {
                if (swipeDistanceX > 0) {
                    // 右スワイプ → 前のページ
                    this.previousPage();
                } else {
                    // 左スワイプ → 次のページ
                    this.nextPage();
                }
            }

            // 状態をリセット
            this.isSwiping = false;
            this.isMultiTouch = false;
            this.swipeStarted = false;
        }, { passive: true });
    };

    // 閲覧モードと編集モードの両方にスワイプを設定
    setupSwipeForElement(viewMode);
    setupSwipeForElement(editMode);

    // デバッグモード：スワイプエリアを可視化
    if (window.location.hash === '#debug') {
        viewMode.style.border = '2px dashed rgba(52, 152, 219, 0.5)';
        viewMode.style.position = 'relative';

        const debugInfo = document.createElement('div');
        debugInfo.textContent = 'スワイプエリア（閲覧モードのみ）';
        debugInfo.style.cssText = `
            position: absolute;
            top: 10px;
            left: 10px;
            background: rgba(52, 152, 219, 0.8);
            color: white;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 12px;
            pointer-events: none;
            z-index: 1000;
        `;
        viewMode.appendChild(debugInfo);
    }
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
            const noteData = {
                id: 'public_' + change.doc.id,
                ...change.doc.data()
            };

            // 自分のノートも含めて全ての公開ノートを更新（名称変更反映のため）
            if (change.type === 'added' || change.type === 'modified') {
                this.notesMap.set(noteData.id, noteData);
                hasChanges = true;

                // 現在表示中のノートが更新された場合
                if (this.currentNote && this.currentNote.id === noteData.id) {
                    // 編集中でない場合のみ更新（編集内容を保護）
                    if (!this.isEditing) {
                        this.currentNote = noteData;
                        this.updateViewer();
                    }
                }
            } else if (change.type === 'removed') {
                this.notesMap.delete(noteData.id);
                hasChanges = true;

                // 現在表示中のノートが削除された場合
                if (this.currentNote && this.currentNote.id === noteData.id) {
                    this.goHome();
                    this.showToast('このノートは削除されました', 'info');
                }
            }
        });
        
        if (hasChanges) {
            this.updateSearchIndex();
            this.updateUI();

            // 公開ノートページが表示されている場合は表示を更新
            if (document.getElementById('publicNotesView').style.display !== 'none') {
                this.updatePublicNotesDisplay();
                this.updatePublicBookshelfDisplay();
            }
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

        // パスワードプロンプトをキャンセルした場合は、適切な画面に戻る
        const isPublicNotesVisible = document.getElementById('publicNotesView').style.display !== 'none';
        const isViewerVisible = document.getElementById('viewerContainer').style.display !== 'none';

        if (isViewerVisible) {
            // ビューアーが表示されていた場合はホームに戻る
            this.goHome();
        } else if (isPublicNotesVisible) {
            // みんなのノート画面が表示されていた場合はそのまま
            return;
        } else {
            // その他の場合はホームに戻る
            this.goHome();
        }
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
    async updateSearchIndex() {
        const notes = Array.from(this.notesMap.values());

        // Fuse.jsを動的読み込み
        const fuseLoaded = await this.ensureFuseLoaded();

        if (fuseLoaded && notes.length > 0) {
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

    // 最後に編集したノートを開く
    editLastBook() {
        if (!this.currentUser) {
            this.showToast('ログインが必要です', 'warning');
            this.showAuthModal();
            return;
        }

        // 自分のノートを更新日時順でソート
        const myNotes = Array.from(this.notesMap.values())
            .filter(note => note.authorId === this.currentUser.uid)
            .sort((a, b) => {
                const dateA = new Date(a.updatedAt || a.createdAt);
                const dateB = new Date(b.updatedAt || b.createdAt);
                return dateB - dateA;
            });

        if (myNotes.length === 0) {
            this.showToast('編集できるノートがありません', 'warning');
            return;
        }

        // 最新のノートを編集モードで開く
        this.openBook(myNotes[0].id, true);
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
                // パスワードチェックに失敗した場合は、既に closePasswordPrompt で適切な画面に戻る
                return;
            }
        }

        this.currentNote = note;
        this.currentPage = 0;
        this.isEditing = editMode;

        // ボタンのアイコンを設定
        const editBtn = document.getElementById('editToggleBtn');
        if (editBtn) {
            if (editMode) {
                editBtn.textContent = '👁️';
                editBtn.title = '閲覧モード (e)';
                editBtn.className = 'btn btn-primary';
            } else {
                editBtn.textContent = '✏️';
                editBtn.title = '編集 (e)';
                editBtn.className = 'btn btn-secondary';
            }
        }

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

        const editToggleBtn = document.getElementById('editToggleBtn');
        if (editToggleBtn) {
            editToggleBtn.style.display = isOwner ? 'inline-flex' : 'none';
        }

        const addPageBtn = document.getElementById('addPageBtn');
        if (addPageBtn) {
            // 編集モードの時だけ表示
            addPageBtn.style.display = (isOwner && this.isEditing) ? 'inline-flex' : 'none';
        }

        const deleteBookBtn = document.getElementById('deleteBookBtn');
        if (deleteBookBtn) {
            deleteBookBtn.style.display = isOwner ? 'inline-flex' : 'none';
        }

        const pageInfo = document.getElementById('pageInfo');
        if (pageInfo) {
            pageInfo.textContent = `${this.currentPage + 1} / ${this.currentNote.pages.length}`;
        }

        const visibilityIcon = this.getVisibilityIcon();
        const visibilityBtn = document.getElementById('visibilityBtn');
        if (visibilityBtn) {
            visibilityBtn.textContent = visibilityIcon;
            visibilityBtn.title = this.getVisibilityTitle();
        }

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
            const viewMode = document.getElementById('viewMode');
            const editMode = document.getElementById('editMode');
            if (viewMode) viewMode.style.display = 'none';
            if (editMode) editMode.style.display = 'block';

            // スマホ編集時の拡大表示モード
            this.setupMobileEditMode();

            // 編集エリアのスクロール制御を設定
            this.setupTextareaScrolling();

            const bookTitleSection = document.getElementById('bookTitleSection');
            if (this.currentPage === 0 && bookTitleSection) {
                bookTitleSection.style.display = 'block';
                const bookTitleInput = document.getElementById('bookTitleInput');
                if (bookTitleInput) {
                    bookTitleInput.value = this.currentNote.title || '';
                }

                // 色選択セクションを表示
                const colorSection = document.getElementById('bookColorSection');
                if (colorSection) {
                    colorSection.style.display = 'block';
                    this.initializeColorPicker();
                }

                // 1ページ目ではタグ入力を表示
                const tagSection = document.getElementById('pageTagsSection');
                if (tagSection) {
                    tagSection.style.display = 'block';
                }
            } else if (bookTitleSection) {
                bookTitleSection.style.display = 'none';

                // 1ページ目以外では色選択を非表示
                const colorSection = document.getElementById('bookColorSection');
                if (colorSection) {
                    colorSection.style.display = 'none';
                }

                // 1ページ目以外ではタグ入力を非表示
                const tagSection = document.getElementById('pageTagsSection');
                if (tagSection) {
                    tagSection.style.display = 'none';
                }
            }

            const pageTitleInput = document.getElementById('pageTitleInput');
            if (pageTitleInput) {
                pageTitleInput.value = page.title || '';
            }

            const pageContentInput = document.getElementById('pageContentInput');
            if (pageContentInput) {
                pageContentInput.value = page.content || '';
            }

            const pageTagsInput = document.getElementById('pageTagsInput');
            if (pageTagsInput) {
                pageTagsInput.value = (page.tags || []).join(', ');
            }

            const imagePreview = document.getElementById('imagePreview');
            if (imagePreview) {
                if (page.image) {
                    imagePreview.innerHTML = `
                        <img src="${this.escapeHtml(page.image)}" style="max-width: 100%; height: auto; display: block; margin: 0 auto; border-radius: 6px;">
                        <button class="btn btn-danger" onclick="app.removeImage()" style="margin-top: 0.5rem;">削除</button>
                    `;
                } else {
                    imagePreview.innerHTML = '';
                }
            }
        } else {
            const viewMode = document.getElementById('viewMode');
            const editMode = document.getElementById('editMode');
            if (viewMode) viewMode.style.display = 'block';
            if (editMode) editMode.style.display = 'none';

            // スマホ編集拡大表示モードを解除
            this.exitMobileEditMode();

            const pageTitle = document.getElementById('pageTitle');
            if (pageTitle) {
                pageTitle.textContent = page.title || 'ページ' + (this.currentPage + 1);
            }

            const pageImage = document.getElementById('pageImage');
            if (pageImage) {
                if (page.image) {
                    this.setupLazyImage(pageImage, page.image, `${page.title}の画像`);
                    pageImage.style.display = 'block';
                    // 画像サイズ制限を強制
                    pageImage.style.maxWidth = '100%';
                    pageImage.style.height = 'auto';
                } else {
                    pageImage.style.display = 'none';
                }
            }

            // Markdown処理（動的読み込み対応）
            this.renderMarkdownContent(page.content || '');
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
        if (this.currentNote && pageIndex >= 0 && pageIndex < this.currentNote.pages.length) {
            if (this.isEditing) {
                this.saveCurrentPage();
            }
            this.currentPage = pageIndex;
            this.updateViewer();
            this.saveReadingProgress(this.currentNote.id, pageIndex);
            // ページ切り替え後はサイドバーを閉じる
            this.closeSidebar();
        }
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

        // 現在の入力内容を保存
        if (this.isEditing) {
            this.saveCurrentPage();
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
            
            // 可視性アイコンのみ更新（入力内容を保持するためupdateViewer()は呼ばない）
            document.getElementById('visibilityBtn').innerHTML = this.getVisibilityIcon();
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
            // 画像を圧縮
            const compressedFile = await this.compressImage(file);
            const finalFile = compressedFile || file;

            // ファイルサイズの削減をユーザーに通知
            if (compressedFile && compressedFile.size < file.size) {
                const reduction = ((file.size - compressedFile.size) / file.size * 100).toFixed(1);
                this.showToast(`画像を圧縮しました (${reduction}% 削減)`, 'info');
            }

            let imageUrl;

            if (this.storage && this.firebaseInitialized) {
                const storageRef = this.storage.ref(`images/${this.currentUser.uid}/${Date.now()}_${finalFile.name || file.name}`);
                const snapshot = await storageRef.put(finalFile);
                imageUrl = await snapshot.ref.getDownloadURL();
            } else {
                imageUrl = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = (e) => resolve(e.target.result);
                    reader.readAsDataURL(finalFile);
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

    // 画像圧縮機能
    async compressImage(file, maxWidth = 1200, maxHeight = 1200, quality = 0.8) {
        return new Promise((resolve) => {
            // 圧縮が不要な小さいファイルの場合はそのまま返す
            if (file.size < 500 * 1024) { // 500KB未満
                resolve(null);
                return;
            }

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();

            img.onload = () => {
                // 新しいサイズを計算
                const { width, height } = this.calculateNewDimensions(img, maxWidth, maxHeight);

                canvas.width = width;
                canvas.height = height;

                // 高品質な描画設定
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';

                // 画像を描画
                ctx.drawImage(img, 0, 0, width, height);

                // Blobとして出力
                canvas.toBlob((blob) => {
                    if (blob && blob.size < file.size) {
                        // ファイル名を保持
                        const compressedFile = new File([blob], file.name, {
                            type: 'image/jpeg',
                            lastModified: Date.now()
                        });
                        resolve(compressedFile);
                    } else {
                        // 圧縮効果がない場合は元ファイルを使用
                        resolve(null);
                    }
                }, 'image/jpeg', quality);
            };

            img.onerror = () => resolve(null);
            img.src = URL.createObjectURL(file);
        });
    }

    // 画像サイズ計算（アスペクト比を保持）
    calculateNewDimensions(img, maxWidth, maxHeight) {
        let { width, height } = img;

        // 最大サイズ以下の場合はそのまま
        if (width <= maxWidth && height <= maxHeight) {
            return { width, height };
        }

        // アスペクト比を保持してリサイズ
        const aspectRatio = width / height;

        if (width > height) {
            width = Math.min(width, maxWidth);
            height = width / aspectRatio;
        } else {
            height = Math.min(height, maxHeight);
            width = height * aspectRatio;
        }

        return {
            width: Math.round(width),
            height: Math.round(height)
        };
    }

    // 遅延読み込み機能
    setupLazyImage(imgElement, src, alt = '') {
        // プレースホルダー画像（グレーの背景）
        const placeholder = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjMwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZjBmMGYwIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxOCIgZmlsbD0iIzk5OSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPuiqrOOBv+i+vOOBv+S4rS4uLjwvdGV4dD48L3N2Zz4=';

        imgElement.alt = alt;
        imgElement.style.transition = 'opacity 0.3s ease';

        // 初期状態はプレースホルダー
        imgElement.src = placeholder;
        imgElement.style.opacity = '0.7';

        // Intersection Observer で遅延読み込み
        if ('IntersectionObserver' in window) {
            const imageObserver = new IntersectionObserver((entries, observer) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        this.loadImage(img, src);
                        observer.unobserve(img);
                    }
                });
            }, {
                rootMargin: '50px 0px' // 50px手前で読み込み開始
            });

            imageObserver.observe(imgElement);
        } else {
            // Intersection Observer が利用できない場合は即座に読み込み
            this.loadImage(imgElement, src);
        }
    }

    // 画像読み込み処理
    loadImage(imgElement, src) {
        const tempImg = new Image();

        tempImg.onload = () => {
            imgElement.src = src;
            imgElement.style.opacity = '1';
        };

        tempImg.onerror = () => {
            // 読み込みエラー時のフォールバック
            imgElement.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjMwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZjVmNWY1IiBzdHJva2U9IiNkZGQiIHN0cm9rZS13aWR0aD0iMiIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTYiIGZpbGw9IiM5OTkiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj7nlLvlg4/jgpLoqq3jgb/ovrzjgb/jgb7jgZvjgpPjgafjgZfjgZ88L3RleHQ+PC9zdmc+';
            imgElement.style.opacity = '1';
            console.warn('画像の読み込みに失敗しました:', src);
        };

        tempImg.src = src;
    }

    // ===== ドラッグ&ドロップ機能 =====
    setupDragAndDrop() {
        // テキストファイルのドラッグ&ドロップ対応
        const viewerContainer = document.getElementById('viewerContainer');

        // 既存の画像用ドロップゾーンも拡張
        const imageDropZone = document.querySelector('[ondrop="app.handleDrop(event)"]');

        if (viewerContainer) {
            // ビューアー全体でのテキストファイルドロップ
            viewerContainer.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (this.isEditing) {
                    e.dataTransfer.dropEffect = 'copy';
                    viewerContainer.style.backgroundColor = 'rgba(52, 152, 219, 0.1)';
                }
            });

            viewerContainer.addEventListener('dragleave', (e) => {
                e.preventDefault();
                viewerContainer.style.backgroundColor = '';
            });

            viewerContainer.addEventListener('drop', (e) => {
                e.preventDefault();
                viewerContainer.style.backgroundColor = '';

                if (!this.isEditing) {
                    this.showToast('編集モードでのみドラッグ&ドロップが利用できます', 'info');
                    return;
                }

                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    this.handleTextFileUpload(files);
                }
            });
        }

        // 画像ドロップゾーンの機能拡張
        if (imageDropZone) {
            imageDropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                imageDropZone.style.borderColor = 'var(--primary-color)';
                imageDropZone.style.backgroundColor = 'rgba(52, 152, 219, 0.05)';
            });

            imageDropZone.addEventListener('dragleave', (e) => {
                e.preventDefault();
                imageDropZone.style.borderColor = 'var(--border-color)';
                imageDropZone.style.backgroundColor = '';
            });
        }
    }

    // ===== 色選択機能 =====
    setupColorPicker() {
        // 色選択オプションのクリックイベント
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('color-option')) {
                // 選択状態をリセット
                document.querySelectorAll('.color-option').forEach(option => {
                    option.classList.remove('selected');
                });

                // 新しい選択をセット
                e.target.classList.add('selected');

                // 隠しフィールドに値を保存
                const colorInput = document.getElementById('bookColorInput');
                if (colorInput) {
                    colorInput.value = e.target.dataset.color;
                }

                // 本の色を即座に更新（編集中の場合）
                this.updateBookColor(e.target.dataset.color);
            }
        });
    }

    // ===== サイドバー外クリック検出 =====
    setupSidebarClickOutside() {
        document.addEventListener('click', (e) => {
            const sidebar = document.getElementById('sidebar');
            const sidebarToggleBtn = e.target.closest('[onclick*="toggleSidebar"]');

            // サイドバーが開いている状態でのみ処理
            if (sidebar && sidebar.classList.contains('open')) {
                // サイドバー内のクリック、または目次ボタンのクリックは無視
                if (sidebar.contains(e.target) || sidebarToggleBtn) {
                    return;
                }

                // メインコンテンツエリア（編集エリア・ノートエリア）のクリックで閉じる
                const mainContent = e.target.closest('#pageContent, #viewMode, #editMode, main');
                if (mainContent) {
                    this.closeSidebar();
                }
            }
        });
    }

    // 本の色を更新
    updateBookColor(color) {
        if (this.currentNote && this.isEditing) {
            // 現在のノートに色情報を保存
            this.currentNote.bookColor = color;

            // 本棚表示の更新は保存時に行われる
            this.showToast('本の色を変更しました', 'success');
        }
    }

    // 色選択の初期化
    initializeColorPicker() {
        // 現在の本の色を取得（デフォルトは#f8f8f8）
        const currentColor = this.currentNote?.bookColor || '#f8f8f8';

        // 色選択状態をリセット
        document.querySelectorAll('.color-option').forEach(option => {
            option.classList.remove('selected');
        });

        // 現在の色を選択状態にする
        const currentOption = document.querySelector(`[data-color="${currentColor}"]`);
        if (currentOption) {
            currentOption.classList.add('selected');
        }

        // 隠しフィールドに値を設定
        const colorInput = document.getElementById('bookColorInput');
        if (colorInput) {
            colorInput.value = currentColor;
        }
    }

    // 背景色から適切な境界線色を計算
    getBorderColorFromBackground(bgColor) {
        // 色の明度を計算して、適切な境界線色を決定
        const colorMap = {
            '#f8f8f8': '#d0d0d0',
            '#f0f0f0': '#c0c0c0',
            '#e8e8e8': '#b0b0b0',
            '#e0f2f1': '#b2dfdb',
            '#fff3e0': '#ffcc02',
            '#fce4ec': '#f8bbd9',
            '#e8f5e8': '#c8e6c9',
            '#e3f2fd': '#90caf9',
            '#f3e5f5': '#ce93d8',
            '#fff8e1': '#fff176',
            '#fafafa': '#e0e0e0',
            '#f5f5f5': '#d5d5d5'
        };

        return colorMap[bgColor] || '#d0d0d0';
    }

    // テキストファイルのアップロード処理
    async handleTextFileUpload(files) {
        for (let file of files) {
            if (file.type.startsWith('text/') ||
                file.name.endsWith('.md') ||
                file.name.endsWith('.txt') ||
                file.name.endsWith('.csv')) {

                try {
                    const text = await this.readFileAsText(file);
                    this.insertTextIntoEditor(text, file.name);
                    this.showToast(`${file.name} の内容を挿入しました`, 'success');
                } catch (error) {
                    this.showToast(`${file.name} の読み込みに失敗しました`, 'error');
                }
            } else if (file.type.startsWith('image/')) {
                // 画像ファイルの場合は既存の処理を利用
                this.handleImageUpload({ target: { files: [file] } });
            } else {
                this.showToast(`${file.name} はサポートされていないファイル形式です`, 'warning');
            }
        }
    }

    // ファイルをテキストとして読み込み
    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
            reader.readAsText(file, 'UTF-8');
        });
    }

    // エディターにテキストを挿入
    insertTextIntoEditor(text, fileName = '') {
        const contentInput = document.getElementById('pageContentInput');
        if (!contentInput || !this.isEditing) return;

        const cursorPos = contentInput.selectionStart;
        const currentValue = contentInput.value;

        // ファイル名をヘッダーとして追加（マークダウン形式）
        let insertText = text;
        if (fileName) {
            const fileHeader = `\n\n## ${fileName}\n\n`;
            insertText = fileHeader + text + '\n\n';
        }

        // カーソル位置にテキストを挿入
        const newValue = currentValue.slice(0, cursorPos) + insertText + currentValue.slice(cursorPos);
        contentInput.value = newValue;

        // カーソル位置を挿入したテキストの後に移動
        const newCursorPos = cursorPos + insertText.length;
        contentInput.setSelectionRange(newCursorPos, newCursorPos);
        contentInput.focus();

        // 変更を保存
        this.currentNote.pages[this.currentPage].content = newValue;
    }

    // ===== キーボードヘルプ機能 =====
    toggleKeyboardHelp() {
        const modal = document.getElementById('keyboardHelpModal');
        if (modal && !modal.classList.contains('active')) {
            this.showKeyboardHelp();
        } else {
            this.closeKeyboardHelp();
        }
    }

    showKeyboardHelp() {
        console.log('showKeyboardHelp called');
        const modal = document.getElementById('keyboardHelpModal');
        console.log('Modal element:', modal);
        if (modal) {
            modal.classList.add('active');
            this.disableBodyScroll();
            console.log('Modal should be visible now');

            // フォーカスをモーダルに移動（アクセシビリティ）
            modal.focus();
        } else {
            console.error('keyboardHelpModal not found');
        }
    }

    closeKeyboardHelp() {
        const modal = document.getElementById('keyboardHelpModal');
        if (modal) {
            modal.classList.remove('active');
            this.checkAllModals();
        }
    }

    // ===== パスワードリセット完了確認 =====
    checkPasswordResetCompletion() {
        const urlParams = new URLSearchParams(window.location.search);
        const mode = urlParams.get('mode');
        const oobCode = urlParams.get('oobCode');

        if (mode === 'resetPassword' && oobCode) {
            // パスワードリセット用のモーダルを表示
            this.showPasswordResetConfirm(oobCode);
        }
    }

    showPasswordResetConfirm(oobCode) {
        // 新しいパスワード入力モーダルを表示
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content">
                <h3>新しいパスワードを設定</h3>
                <p style="color: var(--text-secondary); margin-bottom: 1rem;">新しいパスワードを入力してください。</p>

                <form id="newPasswordForm">
                    <div class="form-group">
                        <label class="form-label">新しいパスワード</label>
                        <input
                            type="password"
                            id="newPasswordInput"
                            class="form-input"
                            required
                            placeholder="6文字以上"
                            minlength="6"
                        >
                        <div id="newPasswordError" class="form-error"></div>
                    </div>

                    <div class="form-group">
                        <label class="form-label">パスワード確認</label>
                        <input
                            type="password"
                            id="confirmPasswordInput"
                            class="form-input"
                            required
                            placeholder="もう一度入力してください"
                        >
                        <div id="confirmPasswordError" class="form-error"></div>
                    </div>

                    <div class="modal-buttons">
                        <button type="submit" class="btn-filled">パスワードを設定</button>
                    </div>
                </form>
            </div>
        `;

        document.body.appendChild(modal);

        // フォーム送信処理
        modal.querySelector('#newPasswordForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleNewPasswordSubmit(oobCode, modal);
        });

        modal.style.display = 'flex';
    }

    async handleNewPasswordSubmit(oobCode, modal) {
        const newPassword = document.getElementById('newPasswordInput').value;
        const confirmPassword = document.getElementById('confirmPasswordInput').value;
        const newPasswordError = document.getElementById('newPasswordError');
        const confirmPasswordError = document.getElementById('confirmPasswordError');

        // エラーをクリア
        newPasswordError.textContent = '';
        confirmPasswordError.textContent = '';

        // バリデーション
        if (newPassword.length < 6) {
            newPasswordError.textContent = 'パスワードは6文字以上で入力してください';
            return;
        }

        if (newPassword !== confirmPassword) {
            confirmPasswordError.textContent = 'パスワードが一致しません';
            return;
        }

        try {
            // パスワードをリセット
            await this.auth.confirmPasswordReset(oobCode, newPassword);

            // モーダルを閉じる
            document.body.removeChild(modal);

            // URLパラメータをクリア
            window.history.replaceState({}, document.title, window.location.pathname);

            // 成功メッセージとログインモーダルを表示
            this.showToast('パスワードが正常に設定されました。新しいパスワードでログインしてください。', 'success');

            setTimeout(() => {
                this.showAuthModal();
            }, 1000);

        } catch (error) {
            console.error('Password reset error:', error);

            if (error.code === 'auth/invalid-action-code') {
                newPasswordError.textContent = 'リセットリンクが無効または期限切れです';
            } else if (error.code === 'auth/weak-password') {
                newPasswordError.textContent = 'パスワードが弱すぎます';
            } else {
                newPasswordError.textContent = 'パスワードの設定に失敗しました。再試行してください';
            }
        }
    }

    // ===== パスワードリセット機能 =====
    showPasswordReset(event) {
        event.preventDefault();
        this.closeAuthModal();

        const modal = document.getElementById('passwordResetModal');
        if (modal) {
            modal.classList.add('active');
            this.disableBodyScroll();

            // フィールドをクリア
            document.getElementById('resetEmailInput').value = '';
            document.getElementById('resetEmailError').textContent = '';
        }
    }

    closePasswordReset() {
        const modal = document.getElementById('passwordResetModal');
        if (modal) {
            modal.classList.remove('active');
            this.checkAllModals();
        }
    }

    async handlePasswordReset(event) {
        event.preventDefault();

        const email = document.getElementById('resetEmailInput').value.trim();
        const errorEl = document.getElementById('resetEmailError');

        // バリデーション
        if (!email) {
            errorEl.textContent = 'メールアドレスを入力してください';
            return;
        }

        if (!this.validateEmail(email)) {
            errorEl.textContent = '有効なメールアドレスを入力してください';
            return;
        }

        try {
            errorEl.textContent = '';

            if (this.auth && this.firebaseInitialized) {
                // Firebase Auth のパスワードリセット
                await this.auth.sendPasswordResetEmail(email);

                this.showToast('パスワードリセットメールを送信しました。メールをご確認ください。', 'success');
                this.closePasswordReset();
            } else {
                // Firebase が利用できない場合のフォールバック
                this.showToast('パスワードリセット機能は現在利用できません', 'error');
            }
        } catch (error) {
            console.error('Password reset error:', error);

            if (error.code === 'auth/user-not-found') {
                errorEl.textContent = 'このメールアドレスは登録されていません';
            } else if (error.code === 'auth/invalid-email') {
                errorEl.textContent = '無効なメールアドレスです';
            } else if (error.code === 'auth/too-many-requests') {
                errorEl.textContent = 'リクエストが多すぎます。しばらく待ってから再試行してください';
            } else {
                errorEl.textContent = 'エラーが発生しました。再試行してください';
            }
        }
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
        this.updateTOC(); // 明示的に目次を更新
        this.updatePageNavigation(); // ページナビも更新
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
                <button class="btn btn-secondary hide-on-mobile" onclick="app.showKeyboardHelp()" aria-label="キーボードヘルプ" title="キーボードショートカット (?)">⌨️</button>
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
                <button class="btn btn-secondary hide-on-mobile" onclick="app.showKeyboardHelp()" aria-label="キーボードヘルプ" title="キーボードショートカット (?)">⌨️</button>
                <button class="btn btn-primary" onclick="app.showAuthModal()" aria-label="ログイン" title="ログイン">
                    👤
                </button>
            `;
            document.getElementById('myBooksSection').style.display = 'none';
        }
    }

    updateMyBooks() {
        if (!this.currentUser) return;

        const myNotes = Array.from(this.notesMap.values())
            .filter(n => n.authorId === this.currentUser.uid && !n.id.startsWith('public_'))
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        if (this.displayMode === 'shelf') {
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
                    📝 ${note.pages.length}ページ • 📊 ${note.views || 0}回
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
                    <div class="toc-page ${activeClass}"
                         onclick="app.goToPage(${actualPageIndex})"
                         style="cursor: pointer;">
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
        const overlay = document.getElementById('sidebarOverlay');

        if (!sidebar) return;

        const isOpen = sidebar.classList.contains('open');

        if (isOpen) {
            // 閉じる
            sidebar.classList.remove('open');
            if (overlay) overlay.classList.remove('active');
        } else {
            // 開く
            sidebar.classList.add('open');
            if (overlay) overlay.classList.add('active');
            // 目次を更新
            this.updateTOC();
        }
    }

    // サイドバーを閉じる
    closeSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('active');
    }

    goHome() {
        if (this.isEditing && this.currentNote) {
            if (confirm('変更を保存しますか？')) {
                this.saveBook();
            }
        }

        document.getElementById('homeView').style.display = 'block';
        document.getElementById('viewerContainer').style.display = 'none';
        document.getElementById('publicNotesView').style.display = 'none';
        this.closeSidebar();

        // ホーム画面の「みんなのノート」セクションも非表示にする
        document.getElementById('publicBooksSection').style.display = 'none';

        this.currentNote = null;
        this.currentPage = 0;
        this.isEditing = false;
        this.updateUI();
    }

    async showPublicBooks() {
        // みんなのノート専用ページに遷移
        document.getElementById('homeView').style.display = 'none';
        document.getElementById('viewerContainer').style.display = 'none';
        document.getElementById('publicNotesView').style.display = 'block';

        // データを初期化
        await this.initializePublicNotesPage();
    }

    // みんなのノートページの初期化
    async initializePublicNotesPage() {
        // ページネーション初期化
        this.currentShelfPage = 1;

        // 公開ノートを全て取得
        await this.loadAllPublicNotes();

        // タブを初期化（本棚表示）
        this.switchPublicView('shelf');

        // 検索機能を設定
        this.setupPublicSearch();

        // フィルター機能を設定
        this.setupPublicFilters();
    }

    // 公開ノートの段階的読み込み（高速化）
    async loadAllPublicNotes() {
        this.publicNotes = [];
        this.currentPage = 1;
        this.currentShelfPage = 1;
        this.notesPerPage = 12;
        this.isLoadingPublicNotes = false;
        this.hasMorePublicNotes = true;

        try {
            // まず初期ロード（少数のノート）
            await this.loadInitialPublicNotes();

            // バックグラウンドで残りを読み込み
            this.loadRemainingPublicNotesInBackground();

        } catch (error) {
            console.error('Failed to load public notes:', error);
            this.showToast('公開ノートの読み込みに失敗しました', 'error');
        }
    }

    // 初期の公開ノートを読み込み（高速表示用）
    async loadInitialPublicNotes() {
        try {
            // ローカルから既存の公開ノートを即座に表示
            Array.from(this.notesMap.values()).forEach(note => {
                if (note.isPublic || note.visibility?.type === 'public') {
                    this.publicNotes.push(note);
                }
            });

            // 最初の12件をFirestoreから取得
            if (this.db && this.firebaseInitialized) {
                const publicNotesRef = this.db.collection('publicNotes')
                    .orderBy('updatedAt', 'desc')
                    .limit(12);
                const snapshot = await publicNotesRef.get();

                snapshot.forEach(doc => {
                    const note = { id: doc.id, ...doc.data() };
                    this.publicNotes.push(note);
                });
            }

            // 重複を削除して即座に表示
            this.deduplicatePublicNotes();
            this.sortPublicNotes('alphabetical');

        } catch (error) {
            console.error('初期公開ノート読み込みエラー:', error);
        }
    }

    // バックグラウンドで残りの公開ノートを読み込み
    async loadRemainingPublicNotesInBackground() {
        try {
            if (!this.db || !this.firebaseInitialized) return;

            // 少し遅延させてから残りを読み込み（UIをブロックしない）
            setTimeout(async () => {
                const publicNotesRef = this.db.collection('publicNotes')
                    .orderBy('updatedAt', 'desc');
                const snapshot = await publicNotesRef.get();

                const newNotes = [];
                snapshot.forEach(doc => {
                    const note = { id: doc.id, ...doc.data() };
                    newNotes.push(note);
                });

                // 新しいノートを追加
                this.publicNotes = [...this.publicNotes, ...newNotes];
                this.deduplicatePublicNotes();
                this.sortPublicNotes('alphabetical');

                // 表示更新
                this.updatePublicNotesDisplay();
                this.updatePublicBookshelfDisplay();

            }, 1000); // 1秒遅延

        } catch (error) {
            console.error('バックグラウンド読み込みエラー:', error);
        }
    }

    // 重複排除ヘルパー関数
    deduplicatePublicNotes() {
        const uniqueNotes = new Map();
        this.publicNotes.forEach(note => {
            const id = note.id.replace('public_', '');
            if (!uniqueNotes.has(id) || note.views > (uniqueNotes.get(id).views || 0)) {
                uniqueNotes.set(id, note);
            }
        });
        this.publicNotes = Array.from(uniqueNotes.values());
    }

    // 公開ノートのソート
    sortPublicNotes(sortBy) {
        switch (sortBy) {
            case 'newest':
                this.publicNotes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
                break;
            case 'popular':
                this.publicNotes.sort((a, b) => (b.views || 0) - (a.views || 0));
                break;
            case 'views':
                this.publicNotes.sort((a, b) => (b.views || 0) - (a.views || 0));
                break;
            case 'pages':
                this.publicNotes.sort((a, b) => (b.pages?.length || 0) - (a.pages?.length || 0));
                break;
            case 'alphabetical':
                this.publicNotes.sort((a, b) => this.compareJapanese(a, b));
                break;
        }
        this.updatePublicNotesDisplay();
    }

    // 表示切り替え（すべて/本棚/タグ別）
    switchPublicView(view) {
        // フッタータブの状態を更新
        document.querySelectorAll('.footer-tab-btn').forEach(btn => {
            btn.classList.remove('active');
            btn.style.color = 'var(--text-secondary)';
            btn.style.background = 'none';
        });

        // 全てのビューを非表示
        document.getElementById('allNotesView').style.display = 'none';
        document.getElementById('publicShelfView').style.display = 'none';
        document.getElementById('taggedNotesView').style.display = 'none';

        if (view === 'all') {
            const allTab = document.getElementById('allNotesTab');
            allTab.classList.add('active');
            allTab.style.color = 'var(--text-primary)';
            allTab.style.background = '#f5f5f5';
            document.getElementById('allNotesView').style.display = 'block';
            this.updatePublicNotesDisplay();
        } else if (view === 'shelf') {
            const shelfTab = document.getElementById('publicShelfTab');
            shelfTab.classList.add('active');
            shelfTab.style.color = 'var(--text-primary)';
            shelfTab.style.background = '#f5f5f5';
            document.getElementById('publicShelfView').style.display = 'block';
            this.updatePublicBookshelfDisplay();
        } else if (view === 'tags') {
            const tagTab = document.getElementById('taggedNotesTab');
            tagTab.classList.add('active');
            tagTab.style.color = 'var(--text-primary)';
            tagTab.style.background = '#f5f5f5';
            document.getElementById('taggedNotesView').style.display = 'block';
            this.loadPopularTags();
        }
    }

    // 公開ノート表示を更新
    updatePublicNotesDisplay() {
        const container = document.getElementById('publicNotesList');

        if (this.publicNotes.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 2rem;">公開されているノートはありません</p>';
            return;
        }

        // フィルタリング
        let filteredNotes = [...this.publicNotes];

        const authorFilter = document.getElementById('authorFilter')?.value.toLowerCase();
        if (authorFilter) {
            filteredNotes = filteredNotes.filter(note =>
                note.author?.toLowerCase().includes(authorFilter)
            );
        }

        // ページネーション
        const startIndex = (this.currentPage - 1) * this.notesPerPage;
        const endIndex = startIndex + this.notesPerPage;
        const paginatedNotes = filteredNotes.slice(startIndex, endIndex);

        // ノートカードを表示
        container.innerHTML = paginatedNotes.map(note => this.createPublicNoteCard(note)).join('');

        // ページネーションを更新
        this.updatePagination(filteredNotes.length);
    }

    // 公開ノートカードを作成
    createPublicNoteCard(note) {
        const tags = (note.tags || []).slice(0, 3).map(tag =>
            `<span class="tag" onclick="event.stopPropagation(); app.filterByTag('${this.escapeHtml(tag)}')">${this.escapeHtml(tag)}</span>`
        ).join('');

        const views = note.views ? `📊 ${note.views}` : '';
        const pages = note.pages ? `📄 ${note.pages.length}P` : '';

        return `
            <div class="book-card" onclick="app.openPublicNote('${note.id}')">
                <h3 style="font-size: 1rem; margin-bottom: 0.5rem; height: 3rem; overflow: hidden;">${this.escapeHtml(note.title)}</h3>
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 0.5rem;">by ${this.escapeHtml(note.author)}</p>
                <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 1rem;">
                    <span>${views}</span>
                    <span>${pages}</span>
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: auto;">
                    ${tags}
                </div>
            </div>
        `;
    }

    // ページネーション更新
    updatePagination(totalNotes) {
        const totalPages = Math.ceil(totalNotes / this.notesPerPage);
        const pagination = document.getElementById('pagination');

        if (totalPages <= 1) {
            pagination.innerHTML = '';
            return;
        }

        let paginationHTML = '';

        // 前へボタン
        paginationHTML += `<button ${this.currentPage === 1 ? 'disabled' : ''} onclick="app.goToPublicNotesPage(${this.currentPage - 1})">←</button>`;

        // ページ番号
        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= this.currentPage - 2 && i <= this.currentPage + 2)) {
                paginationHTML += `<button ${i === this.currentPage ? 'class="active"' : ''} onclick="app.goToPublicNotesPage(${i})">${i}</button>`;
            } else if (i === this.currentPage - 3 || i === this.currentPage + 3) {
                paginationHTML += '<span>...</span>';
            }
        }

        // 次へボタン
        paginationHTML += `<button ${this.currentPage === totalPages ? 'disabled' : ''} onclick="app.goToPublicNotesPage(${this.currentPage + 1})">→</button>`;

        pagination.innerHTML = paginationHTML;
    }

    // ページ移動（公開ノート用）
    goToPublicNotesPage(page) {
        this.currentPage = page;
        this.updatePublicNotesDisplay();
        document.getElementById('publicNotesList').scrollIntoView({ behavior: 'smooth' });
    }

    // 公開本棚表示を更新
    updatePublicBookshelfDisplay() {
        const container = document.getElementById('publicBookshelf');

        if (!this.publicNotes || this.publicNotes.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; grid-column: 1/-1; padding: 2rem;">公開されているノートはありません</p>';
            return;
        }

        // フィルタリングと五十音順ソート
        let filteredNotes = [...this.publicNotes];

        // 五十音順にソート
        filteredNotes.sort((a, b) => this.compareJapanese(a, b));

        const authorFilter = document.getElementById('shelfAuthorFilter')?.value.toLowerCase();
        if (authorFilter) {
            filteredNotes = filteredNotes.filter(note =>
                note.author?.toLowerCase().includes(authorFilter)
            );
        }

        // ページネーション
        const startIndex = (this.currentShelfPage - 1) * this.notesPerPage;
        const endIndex = startIndex + this.notesPerPage;
        const paginatedNotes = filteredNotes.slice(startIndex, endIndex);

        // 本棚表示用の本スパインを生成
        container.innerHTML = paginatedNotes.map((note, index) => {
            const hasPassword = note.password || note.visibility?.type === 'password';
            const lockIcon = hasPassword ? '<div class="book-spine-lock">🔐</div>' : '';
            const bookColor = note.bookColor || '#f8f8f8'; // デフォルトの白色
            const borderColor = this.getBorderColorFromBackground(bookColor);

            return `
                <div class="book-spine"
                     onclick="app.openPublicNote('${note.id}')"
                     title="${this.escapeHtml(note.title)} by ${this.escapeHtml(note.author)}"
                     style="background: ${bookColor}; border-color: ${borderColor};">
                    ${lockIcon}
                    <div class="book-spine-title">${this.escapeHtml(this.truncateTitle(note.title, 10))}</div>
                    <div class="book-spine-meta">${note.pages?.length || 0}P</div>
                </div>
            `;
        }).join('');

        // 本棚用ページネーションを更新
        this.updateShelfPagination(filteredNotes.length);
    }

    // 本棚用ページネーション更新
    updateShelfPagination(totalNotes) {
        const totalPages = Math.ceil(totalNotes / this.notesPerPage);
        const pagination = document.getElementById('shelfPagination');

        if (totalPages <= 1) {
            pagination.innerHTML = '';
            return;
        }

        let paginationHTML = '';

        // 前へボタン
        paginationHTML += `<button ${this.currentShelfPage === 1 ? 'disabled' : ''} onclick="app.goToShelfPage(${this.currentShelfPage - 1})">←</button>`;

        // ページ番号
        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= this.currentShelfPage - 2 && i <= this.currentShelfPage + 2)) {
                paginationHTML += `<button ${i === this.currentShelfPage ? 'class="active"' : ''} onclick="app.goToShelfPage(${i})">${i}</button>`;
            } else if (i === this.currentShelfPage - 3 || i === this.currentShelfPage + 3) {
                paginationHTML += '<span>...</span>';
            }
        }

        // 次へボタン
        paginationHTML += `<button ${this.currentShelfPage === totalPages ? 'disabled' : ''} onclick="app.goToShelfPage(${this.currentShelfPage + 1})">→</button>`;

        pagination.innerHTML = paginationHTML;
    }

    // 本棚ページ移動
    goToShelfPage(page) {
        this.currentShelfPage = page;
        this.updatePublicBookshelfDisplay();
        document.getElementById('publicBookshelf').scrollIntoView({ behavior: 'smooth' });
    }

    // ランダムな本の色を生成
    getRandomBookColor(index) {
        const colors = [
            '#f8f8f8', '#f0f0f0', '#e8e8e8', '#e0f2f1', '#fff3e0',
            '#fce4ec', '#e8f5e8', '#e3f2fd', '#f3e5f5', '#fff8e1',
            '#fafafa', '#f5f5f5'
        ];
        return colors[index % colors.length];
    }

    // 人気タグを読み込み
    loadPopularTags() {
        const tagCount = new Map();

        // 全ての公開ノートからタグを収集
        this.publicNotes.forEach(note => {
            (note.tags || []).forEach(tag => {
                tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
            });
        });

        // タグを使用回数順にソート
        const sortedTags = Array.from(tagCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20); // 上位20タグ

        // タグを表示
        const container = document.getElementById('publicPopularTagsList');
        if (sortedTags.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 2rem;">まだタグが付けられたノートがありません。<br>ノートを作成してタグを追加してみてください。</p>';
        } else {
            container.innerHTML = sortedTags.map(([tag, count]) =>
                `<span class="tag" onclick="app.filterByTag('${this.escapeHtml(tag)}')">${this.escapeHtml(tag)} (${count})</span>`
            ).join('');
        }

        // タグ別ノート一覧をクリア
        document.getElementById('taggedNotesList').innerHTML = '';
        document.getElementById('selectedTagInfo').style.display = 'none';
    }

    // タグでフィルタリング
    filterByTag(tag) {
        // タグ別表示モードに切り替え
        this.switchPublicView('tags');

        // フィルタリングされたノートを取得
        const filteredNotes = this.publicNotes.filter(note =>
            (note.tags || []).includes(tag)
        );

        // 選択中のタグ情報を表示
        document.getElementById('selectedTagName').textContent = tag;
        document.getElementById('selectedTagInfo').style.display = 'block';

        // ノート一覧を更新
        const container = document.getElementById('taggedNotesList');
        if (filteredNotes.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 2rem;">このタグのノートはありません</p>';
        } else {
            container.innerHTML = filteredNotes.map(note => this.createPublicNoteCard(note)).join('');
        }

        // タグを選択状態にする
        document.querySelectorAll('#publicPopularTagsList .tag').forEach(tagEl => {
            tagEl.classList.remove('selected');
            if (tagEl.textContent.startsWith(tag + ' ')) {
                tagEl.classList.add('selected');
            }
        });
    }

    // タグフィルターをクリア
    clearTagFilter() {
        document.getElementById('selectedTagInfo').style.display = 'none';
        document.getElementById('taggedNotesList').innerHTML = '';
        document.querySelectorAll('#publicPopularTagsList .tag').forEach(tagEl => {
            tagEl.classList.remove('selected');
        });
    }

    // 公開ノート検索機能を設定
    setupPublicSearch() {
        const searchInput = document.getElementById('publicSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', this.debounce(() => {
                this.searchPublicNotes(searchInput.value);
            }, 300));
        }
    }

    // 公開ノートを検索
    searchPublicNotes(query) {
        if (!query.trim()) {
            this.updatePublicNotesDisplay();
            return;
        }

        const filteredNotes = this.publicNotes.filter(note => {
            const searchText = `${note.title} ${note.author} ${(note.tags || []).join(' ')}`.toLowerCase();
            return searchText.includes(query.toLowerCase());
        });

        // 検索結果を表示
        const container = document.getElementById('publicNotesList');
        if (filteredNotes.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 2rem;">検索結果が見つかりません</p>';
        } else {
            container.innerHTML = filteredNotes.map(note => this.createPublicNoteCard(note)).join('');
        }

        // ページネーションを非表示
        document.getElementById('pagination').innerHTML = '';
    }

    // フィルター機能を設定
    setupPublicFilters() {
        // ソート変更
        const sortSelect = document.getElementById('sortSelect');
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                this.sortPublicNotes(e.target.value);
            });
        }

        // 作者フィルター
        const authorFilter = document.getElementById('authorFilter');
        if (authorFilter) {
            authorFilter.addEventListener('input', this.debounce(() => {
                this.currentPage = 1;
                this.updatePublicNotesDisplay();
            }, 300));
        }

        // 本棚表示のソート変更
        const shelfSortSelect = document.getElementById('shelfSortSelect');
        if (shelfSortSelect) {
            shelfSortSelect.addEventListener('change', (e) => {
                this.sortPublicNotes(e.target.value);
                this.updatePublicBookshelfDisplay();
            });
        }

        // 本棚表示の作者フィルター
        const shelfAuthorFilter = document.getElementById('shelfAuthorFilter');
        if (shelfAuthorFilter) {
            shelfAuthorFilter.addEventListener('input', this.debounce(() => {
                this.currentShelfPage = 1;
                this.updatePublicBookshelfDisplay();
            }, 300));
        }
    }

    // フィルターをクリア
    clearFilters() {
        document.getElementById('sortSelect').value = 'newest';
        document.getElementById('authorFilter').value = '';
        document.getElementById('publicSearchInput').value = '';
        this.currentPage = 1;
        this.sortPublicNotes('newest');
    }

    // 本棚表示のフィルターをクリア
    clearShelfFilters() {
        document.getElementById('shelfSortSelect').value = 'newest';
        document.getElementById('shelfAuthorFilter').value = '';
        this.currentShelfPage = 1;
        this.sortPublicNotes('newest');
        this.updatePublicBookshelfDisplay();
    }

    // 公開ノートを開く
    openPublicNote(noteId) {
        // 公開ノートページから通常のビューアーに遷移
        document.getElementById('publicNotesView').style.display = 'none';
        this.openBook(noteId, false);
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

    truncateTitle(title, maxLength) {
        if (!title) return '';
        if (title.length <= maxLength) return title;
        return title.substring(0, maxLength) + '...';
    }

    // 日本語優先の五十音順ソート
    compareJapanese(a, b) {
        const titleA = (a.title || '').trim();
        const titleB = (b.title || '').trim();

        // 両方が日本語文字で始まる場合
        if (this.startsWithJapanese(titleA) && this.startsWithJapanese(titleB)) {
            return titleA.localeCompare(titleB, 'ja', {
                numeric: true,
                sensitivity: 'base',
                kana: 'ignore' // ひらがな・カタカナを区別しない
            });
        }

        // 一方が日本語、もう一方がアルファベット/数字の場合
        if (this.startsWithJapanese(titleA) && !this.startsWithJapanese(titleB)) {
            return -1; // 日本語を先に
        }
        if (!this.startsWithJapanese(titleA) && this.startsWithJapanese(titleB)) {
            return 1; // 日本語を先に
        }

        // 両方がアルファベット/数字の場合
        return titleA.localeCompare(titleB, 'ja', { numeric: true });
    }

    // 日本語文字（ひらがな・カタカナ・漢字）で始まるかチェック
    startsWithJapanese(str) {
        if (!str) return false;
        const firstChar = str.charAt(0);
        // ひらがな、カタカナ、漢字の範囲をチェック
        return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(firstChar);
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

    // ===== スクロール管理 =====
    disableBodyScroll() {
        if (!document.body.hasAttribute('data-scroll-disabled')) {
            document.body.style.overflow = 'hidden';
            document.body.setAttribute('data-scroll-disabled', 'true');
        }
    }

    enableBodyScroll() {
        if (document.body.hasAttribute('data-scroll-disabled')) {
            document.body.style.overflow = '';
            document.body.removeAttribute('data-scroll-disabled');
        }
    }

    // すべてのモーダルが閉じられているかチェック
    checkAllModals() {
        const modals = [
            'authModal',
            'keyboardHelpModal',
            'passwordResetModal',
            'visibilityModal',
            'shareModal',
            'passwordPromptModal'
        ];

        const hasOpenModal = modals.some(modalId => {
            const modal = document.getElementById(modalId);
            return modal && (modal.style.display === 'flex' || modal.classList.contains('active'));
        });

        if (!hasOpenModal) {
            this.enableBodyScroll();
        }
    }

    // 編集エリアのスクロール制御
    setupEditScrolling() {
        document.addEventListener('DOMContentLoaded', () => {
            const textarea = document.getElementById('pageContentInput');
            if (textarea) {
                // テキストエリア内でのスクロールイベントを停止伝播させない
                textarea.addEventListener('wheel', (e) => {
                    e.stopPropagation();
                });

                // タッチイベントでのスクロール制御
                textarea.addEventListener('touchstart', (e) => {
                    e.stopPropagation();
                });

                textarea.addEventListener('touchmove', (e) => {
                    e.stopPropagation();
                });
            }
        });
    }

    // テキストエリア専用のスクロール制御
    setupTextareaScrolling() {
        const textarea = document.getElementById('pageContentInput');
        if (textarea && !textarea.hasAttribute('data-scroll-setup')) {
            // 重複設定を防ぐ
            textarea.setAttribute('data-scroll-setup', 'true');

            // テキストエリア自動拡張（最低60vhを維持）
            const autoResize = () => {
                const minHeight = window.innerHeight * 0.6;
                const newHeight = Math.max(textarea.scrollHeight, minHeight);
                textarea.style.height = newHeight + 'px';
            };
            textarea.addEventListener('input', autoResize);

            // マウスホイールイベント
            textarea.addEventListener('wheel', (e) => {
                // テキストエリア内でのスクロールを許可
                e.stopPropagation();
            });

            // モバイル用の改善されたタッチイベント処理（慣性スクロール付き）
            let isScrolling = false;
            let touchStartY = 0;
            let touchStartTime = 0;
            let lastTouchY = 0;
            let lastTouchTime = 0;
            let velocityY = 0;
            let scrollTop = 0;

            textarea.addEventListener('touchstart', (e) => {
                e.stopPropagation();
                touchStartY = e.touches[0].clientY;
                touchStartTime = Date.now();
                lastTouchY = touchStartY;
                lastTouchTime = touchStartTime;
                scrollTop = textarea.scrollTop;
                velocityY = 0;
                isScrolling = false;

                // 現在の慣性スクロールがあればストップ
                if (this.inertiaAnimationId) {
                    cancelAnimationFrame(this.inertiaAnimationId);
                    this.inertiaAnimationId = null;
                }
            }, { passive: true });

            textarea.addEventListener('touchmove', (e) => {
                e.stopPropagation();

                const touchY = e.touches[0].clientY;
                const currentTime = Date.now();
                const deltaY = touchStartY - touchY;
                const timeDelta = currentTime - lastTouchTime;

                // スクロール方向の判定
                if (Math.abs(deltaY) > 5) {
                    isScrolling = true;

                    // 速度計算（慣性スクロール用）
                    if (timeDelta > 0) {
                        velocityY = (lastTouchY - touchY) / timeDelta;
                    }

                    // テキストエリア内でのスクロールを手動制御
                    const newScrollTop = scrollTop + deltaY;
                    const maxScroll = textarea.scrollHeight - textarea.clientHeight;

                    if (newScrollTop >= 0 && newScrollTop <= maxScroll) {
                        textarea.scrollTop = newScrollTop;
                        e.preventDefault(); // デフォルトのスクロールを防ぐ
                    }

                    lastTouchY = touchY;
                    lastTouchTime = currentTime;
                }
            }, { passive: false });

            textarea.addEventListener('touchend', (e) => {
                e.stopPropagation();

                // 慣性スクロールを開始
                if (isScrolling && Math.abs(velocityY) > 0.1) {
                    this.startInertiaScroll(textarea, velocityY);
                }

                isScrolling = false;
            }, { passive: true });

            // フォーカス時の処理（iOS Safari対応改善）
            textarea.addEventListener('focus', () => {
                // iOS Safariでのスクロール問題を回避
                if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
                    // iOSデバイスの場合
                    setTimeout(() => {
                        textarea.scrollIntoView({
                            behavior: 'smooth',
                            block: 'center',
                            inline: 'nearest'
                        });
                        // viewportの調整
                        window.scrollTo({
                            top: textarea.offsetTop - (window.innerHeight / 3),
                            behavior: 'smooth'
                        });
                    }, 100);
                } else {
                    // その他のモバイルデバイス
                    setTimeout(() => {
                        textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 200);
                }
            });

            // ブラー時の処理
            textarea.addEventListener('blur', () => {
                // モバイルキーボードが閉じた後のレイアウト調整
                if (window.innerHeight < 500) {
                    setTimeout(() => {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    }, 300);
                }
            });
        }
    }

    // スマホ編集モード - シンプル版（特別な処理なし）
    setupMobileEditMode() {
        // 何もしない - 読む時と同じレイアウトを維持
    }

    exitMobileEditMode() {
        // 何もしない
    }

    // 慣性スクロール実装
    startInertiaScroll(element, velocity) {
        const friction = 0.95; // 摩擦係数（大きいほど滑らか）
        const minVelocity = 0.1; // 最小速度（これ以下でストップ）

        const animate = () => {
            if (Math.abs(velocity) < minVelocity) {
                this.inertiaAnimationId = null;
                return;
            }

            const currentScrollTop = element.scrollTop;
            const newScrollTop = currentScrollTop + velocity * 10; // スケール調整
            const maxScroll = element.scrollHeight - element.clientHeight;

            // 境界チェック
            if (newScrollTop >= 0 && newScrollTop <= maxScroll) {
                element.scrollTop = newScrollTop;
                velocity *= friction; // 摩擦を適用
                this.inertiaAnimationId = requestAnimationFrame(animate);
            } else {
                // 境界に達したら慣性スクロールを停止
                this.inertiaAnimationId = null;
            }
        };

        this.inertiaAnimationId = requestAnimationFrame(animate);
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
