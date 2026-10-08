import ConsolePage from './pages/ConsolePage'
import DisplayPage from './pages/DisplayPage'
import PreviewPage from './pages/PreviewPage'
import TurnAuthorizationDialog from './components/remoteBp/TurnAuthorizationDialog'

function App(): React.JSX.Element {
  const route = window.location.hash.replace(/^#/, '')

  if (route === '/display') {
    return <DisplayPage />
  }

  if (route === '/preview') {
    return <PreviewPage />
  }

  return <><ConsolePage /><TurnAuthorizationDialog /></>
}

export default App
