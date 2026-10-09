/** Test-only React shell; this is not the Harness application. */
import { createRoot } from 'react-dom/client'
import { PackCenterCard } from '../../../../lib/client/pack-center-card.js'

const root = createRoot(document.getElementById('host-ui')!)
root.render(<PackCenterCard close={() => root.unmount()} />)
