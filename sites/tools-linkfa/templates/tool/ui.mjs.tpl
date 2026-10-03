import { calculate } from './logic.mjs'

const form = document.getElementById('calc')
const out = document.getElementById('result')

function render() {
  out.textContent = ''
}

form.addEventListener('submit', (event) => { event.preventDefault(); render() })
