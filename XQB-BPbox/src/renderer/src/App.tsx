import ConsolePage from './pages/ConsolePage'
import DisplayPage from './pages/DisplayPage'
import PreviewPage from './pages/PreviewPage'

function App(): React.JSX.Element {
  const route = window.location.hash.replace(/^#/, '')

  if (route === '/display') {
    return <DisplayPage />
  }

  if (route === '/preview') {
    return <PreviewPage />
  }

  return <ConsolePage />
}

export default App
