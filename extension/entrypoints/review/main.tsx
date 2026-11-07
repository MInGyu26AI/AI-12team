import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/assets/tailwind.css';

// 개인 검토함 (비공개 승인 화면) 자리. CLAUDE.md §7-D 에서 구현
function Review() {
  return (
    <main className="mx-auto max-w-3xl p-6 font-sans">
      <h1 className="text-2xl font-bold">개인 검토함</h1>
      <p className="text-sm text-gray-500">여기에 후보 카드·붙여넣기·내보내기 업로드가 들어갑니다.</p>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Review />
  </React.StrictMode>,
);
