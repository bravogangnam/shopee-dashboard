import { Navigate, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './auth/ProtectedRoute.jsx';
import AppLayout from './layout/AppLayout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import InventoryPage from './pages/InventoryPage.jsx';
import ReceiptManagementPage from './pages/ReceiptManagementPage.jsx';
import LedgerPage from './pages/LedgerPage.jsx';
import OrderManagementPage from './pages/OrderManagementPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import UnifiedProductCapturePage from './pages/UnifiedProductCapturePage.jsx';
import ProductAnalyticsPage from './pages/ProductAnalyticsPage.jsx';
import BrandImageMakerPage from './pages/BrandImageMakerPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Navigate to="/orders" replace />} />
          <Route path="/dashboard" element={<Navigate to="/orders" replace />} />
          <Route path="/orders" element={<OrderManagementPage />} />
          <Route path="/ledger" element={<LedgerPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/receipts" element={<ReceiptManagementPage />} />
          <Route path="/product-analytics" element={<ProductAnalyticsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/product-capture" element={<UnifiedProductCapturePage />} />
          <Route path="/naver-product-capture" element={<Navigate to="/product-capture" replace />} />
          <Route path="/brand-image-maker" element={<BrandImageMakerPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/settings/rates" element={<Navigate to="/settings" replace />} />
          <Route path="/settings/*" element={<Navigate to="/settings" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/orders" replace />} />
    </Routes>
  );
}
