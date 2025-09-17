// ===== StudyBook Application JavaScript =====

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

        // その他
        this.listeners = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.reconnectTimeout = null;
        this.fuseInstance = null;
        this.dataCache = new Map();
        this.lastFetchTime = 0;
        this.cacheTimeout = 30000;
        this.rateLimiter = new Map();
        this.pendingSharedNoteId = null;
        this.dataLoadingComplete = false;
        this.passwordCache = new Map();
        this.pendingPasswordNote = null;

        // スワイプ処理用（新規追加）
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchEndX = 0;
        this.touchEndY = 0;
        this.minSwipeDistance = 50; // 最小スワイプ距離
        this.swipeTimeLimit = 300; // スワイプ時間制限(ms)
        this.touchStartTime = 0;
        this.isSwiping = false;

        // 初期化
        this.init();
    }

    // ===== 初期化処理 =====
    async init() {
        try {
            console.log('App initialization started');
            document.getElementById('loadingText').textContent = 'アプリを準備中...';

            // オフライン処理設定
            this.setupOfflineHandling();

            // イベントリスナー設定
            this.setupEventListeners();

            // ローカルデータを即座に読み込み
            this.loadLocalData();
            this.updateUI();

            // Firebase初期化
            await this.initFirebase();

            // URL パラメータをチェック
            this.checkUrlParams();

            // データロード完了
            this.dataLoadingComplete = true;

            // ローディング完了
            document.getElementById('loadingText').textContent = '完了！';
            
            setTimeout(() => {
                document.getElementById('loadingScreen').classList.add('hidden');
                // スワイプヒントを表示（モバイルのみ）
                if (window.innerWidth <= 768) {
                    this.showSwipeHint();
                }
            }, 500);

        } catch (error) {
            console.error('App initialization error:', error);
            this.handleError(error, 'アプリの初期化でエラーが発生しましたが、基本機能は利用できます');
            
            setTimeout(() => {
                document.getElementById('loadingScreen').classList.add('hidden');
            }, 1000);
        }
    }

    // ===== オフライン処理設定 =====
    setupOfflineHandling() {
        window.addEventListener('online', () => {
            this.isOnline = true;
            this.updateConnectionStatus();
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

    // ===== イベントリスナー設定（スワイプ機能追加） =====
    setupEventListeners() {
        // 検索機能
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', this.debounce(this.handleSearch.bind(this), 300));
            document.addEventListener('click', (e) => {
                if (!searchInput.contains(e.target)) {
                    document.getElementById('searchResults').classList.remove('active');
                }
            });
        }

        // 公開設定の変更
        document.addEventListener('change', (e) => {
            if (e.target.name === 'visibility') {
                this.toggleVisibilityOptions(e.target.value);
            }
        });

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

        // キーボードナビゲーション
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

        // 【新規】スワイプ機能の設定
        this.setupSwipeHandlers();
    }

    // ===== 【新規】スワイプ機能 =====
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

            // 水平方向のスワイプが優勢な場合のみ
            if (diffX > diffY && diffX > 10) {
                this.isSwiping = true;
                // スクロールを防止
                e.preventDefault();
            }
        }, { passive: false });

        // タッチ終了
        pageContent.addEventListener('touchend', (e) => {
            if (!this.currentNote || !this.isSwiping) return;

            this.touchEndX = e.changedTouches[0].clientX;
            this.touchEndY = e.changedTouches[0].clientY;
            
            const swipeTime = Date.now() - this.touchStartTime;
            const swipeDistanceX = this.touchEndX - this.touchStartX;
            const swipeDistanceY = Math.abs(this.touchEndY - this.touchStartY);

            // 水平スワイプの判定（時間制限なし、垂直移動が少ない場合）
            if (Math.abs(swipeDistanceX) > this.minSwipeDistance && 
                swipeDistanceY < 100) {  // 垂直移動の許容値
                
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

        // マウスホイールでのページ移動（デスクトップ用オプション）
        if (window.innerWidth > 768) {
            pageContent.addEventListener('wheel', (e) => {
                if (!this.currentNote || !e.shiftKey) return; // Shiftキー + ホイールで動作
                
                if (e.deltaY < 0) {
                    this.previousPage();
                } else if (e.deltaY > 0) {
                    this.nextPage();
                }
                e.preventDefault();
            }, { passive: false });
        }
    }

    // ===== スワイプヒント表示 =====
    showSwipeHint() {
        if (!this.currentNote) return;
        
        const hint = document.getElementById('swipeHint');
        if (hint) {
            // 初回のみ表示
            const hasShownHint = localStorage.getItem('studybook_swipe_hint_shown');
            if (!hasShownHint) {
                hint.style.opacity = '1';
                setTimeout(() => {
                    hint.style.opacity = '0';
                    localStorage.setItem('studybook_swipe_hint_shown', 'true');
                }, 3000);
            }
        }
    }

    // ===== Firebase初期化 =====
    async initFirebase() {
        try {
            // Firebase SDKが読み込まれるまで待機
            await this.waitForFirebaseSDK();
            
            if (typeof firebase !== 'undefined') {
                firebase.initializeApp(this.firebaseConfig);
                this.auth = firebase.auth();
                this.db = firebase.firestore();
                this.storage = firebase.storage();
                this.firebaseInitialized = true;

                // 認証状態の監視
                this.auth.onAuthStateChanged(this.handleAuthStateChange.bind(this));
            }
        } catch (error) {
            console.warn('Firebase initialization failed:', error);
            this.showToast('一部機能が制限されますが、基本機能は利用できます', 'warning');
        }
    }

    async waitForFirebaseSDK() {
        return new Promise((resolve) => {
            const checkFirebase = () => {
                if (typeof firebase !== 'undefined') {
                    resolve();
                } else {
                    setTimeout(checkFirebase, 100);
                }
            };
            checkFirebase();
            
            // タイムアウト設定
            setTimeout(() => resolve(), 5000);
        });
    }

    // ===== ページナビゲーション =====
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
        }
    }

    // ===== ページ遷移アニメーション =====
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

    // ===== ビューアー更新（画像表示改善） =====
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
                    <img src="${this.escapeHtml(page.image)}" alt="アップロード画像">
                    <button class="btn btn-secondary" onclick="app.removeImage()" style="margin-top: 0.5rem;">削除</button>
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
                // 画像の最大幅を制限
                pageImage.style.maxWidth = '100%';
                pageImage.style.height = 'auto';
            } else {
                document.getElementById('pageImage').style.display = 'none';
            }

            // Markdown処理（画像サイズ制限付き）
            if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
                const cleanContent = DOMPurify.sanitize(page.content || '');
                let htmlContent = marked.parse(cleanContent);
                
                // 画像にクラスを追加してサイズ制限
                htmlContent = htmlContent.replace(/<img/g, '<img style="max-width: 100%; height: auto;"');
                
                document.getElementById('pageBody').innerHTML = DOMPurify.sanitize(htmlContent);
            } else {
                document.getElementById('pageBody').textContent = page.content || '';
            }
        }
    }

    // ===== その他の必要なメソッド（簡略版） =====
    handleAuthStateChange(user) {
        if (user) {
            this.currentUser = {
                uid: user.uid,
                displayName: user.displayName || user.email.split('@')[0],
                email: user.email,
                photoURL: user.photoURL
            };
            this.showToast('ログインしました', 'success');
        } else {
            this.currentUser = null;
        }
        this.updateUI();
    }

    updateUI() {
        // UI更新処理
        this.updateAuthSection();
        this.updateMyBooks();
    }

    updateAuthSection() {
        const authSection = document.getElementById('authSection');
        if (this.currentUser) {
            authSection.innerHTML = `
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <span style="color: var(--text-primary); font-size: 0.9rem;">${this.escapeHtml(this.currentUser.displayName)}</span>
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
        // マイブック更新処理（簡略化）
    }

    loadLocalData() {
        // ローカルデータ読み込み処理
    }

    checkUrlParams() {
        // URLパラメータチェック処理
    }

    saveReadingProgress(noteId, pageIndex) {
        // 読書進捗保存処理
    }

    updateViewer() {
        // ビューアー更新処理
        if (!this.currentNote) return;
        
        document.getElementById('pageInfo').textContent = `${this.currentPage + 1} / ${this.currentNote.pages.length}`;
        this.updatePageContent();
        this.updatePageNavigation();
    }

    updatePageNavigation() {
        // ページナビゲーション更新
        if (!this.currentNote) return;
        
        document.getElementById('prevBtn').disabled = this.currentPage === 0;
        document.getElementById('nextBtn').disabled = this.currentPage === this.currentNote.pages.length - 1;
    }

    saveCurrentPage() {
        // 現在のページを保存
    }

    goToPage(pageIndex) {
        // 特定ページへ移動
        if (this.isEditing) {
            this.saveCurrentPage();
        }
        this.currentPage = pageIndex;
        this.updateViewer();
    }

    toggleSidebar() {
        // サイドバー切り替え
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.toggle('open');
    }

    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast ${type} show`;
        
        setTimeout(() => {
            toast.classList.remove('show');
        }, 2500);
    }

    handleError(error, userMessage) {
        console.error(error);
        this.showToast(userMessage || 'エラーが発生しました', 'error');
    }

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

    // 認証関連のスタブメソッド
    showAuthModal() { /* 実装省略 */ }
    closeAuthModal() { /* 実装省略 */ }
    handleAuthSubmit(event) { /* 実装省略 */ }
    toggleAuthMode(event) { /* 実装省略 */ }
    handleGoogleLogin() { /* 実装省略 */ }
    handleLogout() { /* 実装省略 */ }
    
    // その他のメソッド（実装省略）
    handleSearch(event) { /* 実装省略 */ }
    createNewBook() { /* 実装省略 */ }
    openBook(noteId, editMode) { /* 実装省略 */ }
    saveBook() { /* 実装省略 */ }
    deleteBook() { /* 実装省略 */ }
    addPage() { /* 実装省略 */ }
    goHome() { /* 実装省略 */ }
    setViewMode(mode) { /* 実装省略 */ }
    showPublicBooks() { /* 実装省略 */ }
    showPopularTags() { /* 実装省略 */ }
    searchByTag(tag) { /* 実装省略 */ }
    showVisibilitySettings() { /* 実装省略 */ }
    saveVisibilitySettings() { /* 実装省略 */ }
    closeVisibilityModal() { /* 実装省略 */ }
    toggleVisibilityOptions(type) { /* 実装省略 */ }
    showShareModal() { /* 実装省略 */ }
    closeShareModal() { /* 実装省略 */ }
    copyShareUrl() { /* 実装省略 */ }
    shareToTwitter() { /* 実装省略 */ }
    shareToLine() { /* 実装省略 */ }
    shareToFacebook() { /* 実装省略 */ }
    submitPassword() { /* 実装省略 */ }
    closePasswordPrompt() { /* 実装省略 */ }
    insertMarkdown(before, after) { /* 実装省略 */ }
    insertImageInContent() { /* 実装省略 */ }
    handleImageUpload(event) { /* 実装省略 */ }
    handleDrop(event) { /* 実装省略 */ }
    removeImage() { /* 実装省略 */ }
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
