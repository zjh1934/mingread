import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, CssBaseline } from '@mui/material';
import App from './App';
import { useSettings } from './store/settingsStore';
import { createAppTheme } from './theme';
import './index.css';

function Root() {
  const mode = useSettings((s) => s.themeMode);
  const theme = React.useMemo(() => createAppTheme(mode), [mode]);
  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', mode === 'dark');
  }, [mode]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')).render(<Root />);
