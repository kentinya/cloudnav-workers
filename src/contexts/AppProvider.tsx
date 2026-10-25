import React from 'react';
import { AuthProvider } from './AuthContext';
import { LinksProvider } from './LinksContext';
import { CategoriesProvider } from './CategoriesContext';
import { ConfigProvider } from './ConfigContext';

export function AppProvider({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ConfigProvider>
        <LinksProvider>
          <CategoriesProvider>
            {children}
          </CategoriesProvider>
        </LinksProvider>
      </ConfigProvider>
    </AuthProvider>
  );
}
