// Firebase設定 - 環境変数を使用
// 本番環境では環境変数から取得、開発環境ではデフォルト値を使用

const getFirebaseConfig = () => {
    // 本番環境の環境変数チェック
    if (typeof process !== 'undefined' && process.env) {
        return {
            apiKey: process.env.FIREBASE_API_KEY || "AIzaSyCRRsnIRzveG6B7XzDhUR-OoBWq-SY-5Ew",
            authDomain: process.env.FIREBASE_AUTH_DOMAIN || "book-study-1f25e.firebaseapp.com",
            projectId: process.env.FIREBASE_PROJECT_ID || "book-study-1f25e",
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "book-study-1f25e.firebasestorage.app",
            messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "716923175090",
            appId: process.env.FIREBASE_APP_ID || "1:716923175090:web:2cc8c093c6cdf4ddbe09ab"
        };
    }

    // ブラウザ環境の場合、window.ENV から取得を試行
    if (typeof window !== 'undefined' && window.ENV) {
        return {
            apiKey: window.ENV.FIREBASE_API_KEY || "AIzaSyCRRsnIRzveG6B7XzDhUR-OoBWq-SY-5Ew",
            authDomain: window.ENV.FIREBASE_AUTH_DOMAIN || "book-study-1f25e.firebaseapp.com",
            projectId: window.ENV.FIREBASE_PROJECT_ID || "book-study-1f25e",
            storageBucket: window.ENV.FIREBASE_STORAGE_BUCKET || "book-study-1f25e.firebasestorage.app",
            messagingSenderId: window.ENV.FIREBASE_MESSAGING_SENDER_ID || "716923175090",
            appId: window.ENV.FIREBASE_APP_ID || "1:716923175090:web:2cc8c093c6cdf4ddbe09ab"
        };
    }

    // 開発環境用のデフォルト設定
    console.warn('環境変数が設定されていません。開発環境用の設定を使用します。');
    return {
        apiKey: "AIzaSyCRRsnIRzveG6B7XzDhUR-OoBWq-SY-5Ew",
        authDomain: "book-study-1f25e.firebaseapp.com",
        projectId: "book-study-1f25e",
        storageBucket: "book-study-1f25e.firebasestorage.app",
        messagingSenderId: "716923175090",
        appId: "1:716923175090:web:2cc8c093c6cdf4ddbe09ab"
    };
};

// 設定をエクスポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getFirebaseConfig };
} else {
    window.getFirebaseConfig = getFirebaseConfig;
}