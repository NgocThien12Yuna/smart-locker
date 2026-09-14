import React from 'react';

import AppNavigator from './src/navigation/AppNavigator';

import { LockerProvider } from './src/context/LockerContext';
import { AuthProvider } from './src/context/AuthContext';

export default function App() {
  return (
    <AuthProvider>
      <LockerProvider>
        <AppNavigator />
      </LockerProvider>
    </AuthProvider>
  );
}