import { Navigate, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './auth/ProtectedRoute.jsx';
import AppLayout from './layout/AppLayout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import InventoryPage from './pages/InventoryPage.jsx';
import LedgerPage from './pages/LedgerPage.jsx';
import OrderManagementPage from './pages/OrderManagementPage.jsx';
import RatesPage from './pages/RatesPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Navigate to="/orders" replace />} />
          <Route path="/dashboard" element={<Navigate to="/orders" replace />} />
          <Route path="/orders" element={<OrderManagementPage />} />
          <Route path="/ledger" element={<LedgerPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/settings" element={<Navigate to="/settings/rates" replace />} />
          <Route path="/settings/rates" element={<RatesPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/orders" replace />} />
    </Routes>
  );
}
