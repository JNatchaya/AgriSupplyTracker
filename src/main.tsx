import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { getAddress, isAddress, zeroAddress, type Address } from 'viem'
import { batchKey, errorMessage, explorer, live, provider, readManager, readBatch, readCount, readHistory, readRole, send, type ActionCall, type Batch, type Entry } from './chain'
import './style.css'

const stages = ['เก็บเกี่ยว', 'อยู่ระหว่างขนส่ง', 'ถึงคลังสินค้า', 'ถึงร้านค้า']
const roles = ['ไม่มีสิทธิ์', 'เกษตรกร', 'ผู้ขนส่ง', 'ผู้จัดจำหน่าย', 'ผู้จัดการ']
const events = ['ลงทะเบียนล็อต', 'เสนอส่งมอบ', 'รับมอบล็อต', 'ยกเลิกการส่งมอบ', 'อัปเดตขั้นตอน', 'เรียกคืนล็อต', 'ปิดการเรียกคืน']
const demoManager = '0x1a11111111111111111111111111111111111111'
const sampleFarmer = '0x7a7423195e8B3036708162EeC99e1344A8aC0d55'
const sample: Batch = {
  batchCode: 'GF-2026-001',
  name: 'ผักกาดหอมกรีนโอ๊ค', harvestDate: 1794873600n,
  farmLocation: 'เชียงใหม่', certificate: 'ตัวอย่างใบรับรอง GAP',
  producer: sampleFarmer, holder: sampleFarmer, proposedHolder: zeroAddress,
  status: 1, recallState: 0, recallNote: '',
}
const sampleHistory: Entry[] = [
  { activity: 4, performedBy: sampleFarmer, from: sampleFarmer, to: zeroAddress, status: 1, recordedAt: 1794886200n, details: 'ออกจากฟาร์มเพื่อขนส่งไปคลังสินค้า' },
  { activity: 0, performedBy: sampleFarmer, from: zeroAddress, to: sampleFarmer, status: 0, recordedAt: 1794877200n, details: 'ลงทะเบียนล็อตแล้ว' },
]
const pageSize = 10n
const walletLogoutKey = 'greenfarm.wallet-logged-out'
const date = (seconds: bigint) => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(Number(seconds) * 1000)
const same = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase())
const short = (address: string) => address.slice(0, 6) + '…' + address.slice(-4)

type Operation = NonNullable<ActionCall['functionName']>
type Field = { name: string; label: string; type?: string; optional?: boolean; options?: { value: number; label: string }[] }
const field = (name: string, label: string, type?: string): Field => ({ name, label, type })
const options = (items: string[]) => items.map((label, value) => ({ value, label }))
const definitions: Record<Operation, { label: string; fields: Field[] }> = {
  assignRole: { label: 'กำหนดสิทธิ์บัญชี', fields: [field('account', 'ที่อยู่กระเป๋า'), { name: 'role', label: 'บทบาท', options: options(roles.slice(0, 4)) }] },
  createBatch: { label: 'ลงทะเบียนล็อต', fields: [field('id', 'Batch ID'), field('name', 'ชื่อสินค้า'), field('harvest', 'เวลาเก็บเกี่ยว (ตามเวลาของอุปกรณ์)', 'datetime-local'), field('origin', 'แหล่งผลิต'), field('certificate', 'ใบรับรอง')] },
  requestTransfer: { label: 'เสนอส่งมอบ', fields: [field('recipient', 'ที่อยู่กระเป๋าผู้รับ')] },
  confirmTransfer: { label: 'รับมอบล็อต', fields: [] },
  cancelTransfer: { label: 'ยกเลิกการส่งมอบ', fields: [] },
  updateProductStatus: { label: 'อัปเดตขั้นตอน', fields: [{ name: 'stage', label: 'ขั้นตอนใหม่', options: options(stages) }, { ...field('note', 'หมายเหตุ', 'textarea'), optional: true }] },
  openRecall: { label: 'เรียกคืนล็อต', fields: [field('note', 'เหตุผลที่เรียกคืน', 'textarea')] },
  closeRecall: { label: 'ปิดการเรียกคืน', fields: [field('note', 'ผลการดำเนินการ', 'textarea')] },
}

const menuGroups: { label: string; actions: Operation[] }[] = [
  { label: 'บัญชีและล็อต', actions: ['assignRole', 'createBatch'] },
  { label: 'ส่งมอบ', actions: ['requestTransfer', 'confirmTransfer', 'cancelTransfer'] },
  { label: 'สถานะล็อต', actions: ['updateProductStatus'] },
  { label: 'เรียกคืน', actions: ['openRecall', 'closeRecall'] },
]

function callFor(operation: Operation, data: FormData, id: string): ActionCall {
  function value(name: string, optional = false) {
    const input = String(data.get(name) ?? '').trim()
    if (!input && !optional) throw new Error('กรุณากรอกข้อมูลให้ครบ')
    return input
  }
  function address(name: string) {
    const input = value(name)
    if (!isAddress(input) || same(input, zeroAddress)) throw new Error('ที่อยู่กระเป๋าไม่ถูกต้อง')
    return getAddress(input)
  }

  switch (operation) {
    case 'assignRole': return { functionName: operation, args: [address('account'), Number(value('role'))] }
    case 'createBatch': {
      const batchId = String(data.get('id') ?? '')
      if (!batchId) throw new Error('กรุณาระบุ Batch ID')
      if (new TextEncoder().encode(batchId).length > 64) throw new Error('Batch ID ต้องยาวไม่เกิน 64 ไบต์')
      const timestamp = Math.floor(new Date(value('harvest')).getTime() / 1000)
      if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() / 1000) throw new Error('เวลาเก็บเกี่ยวไม่ถูกต้อง')
      return { functionName: operation, args: [batchId, value('name'), BigInt(timestamp), value('origin'), value('certificate')] }
    }
    case 'requestTransfer': return { functionName: operation, args: [batchKey(id), address('recipient')] }
    case 'updateProductStatus': return { functionName: operation, args: [batchKey(id), Number(value('stage')), value('note', true)] }
    case 'confirmTransfer':
    case 'cancelTransfer': return { functionName: operation, args: [batchKey(id)] }
    default: return { functionName: operation, args: [batchKey(id), value('note')] }
  }
}

function App() {
  const [query, setQuery] = useState(live ? '' : sample.batchCode)
  const [result, setResult] = useState(live ? null : { id: sample.batchCode, batch: sample, count: BigInt(sampleHistory.length) })
  const [entries, setEntries] = useState(live ? [] : sampleHistory)
  const [searching, setSearching] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const searchVersion = useRef(0)
  const [account, setAccount] = useState<Address>()
  const loggedOut = useRef(sessionStorage.getItem(walletLogoutKey) === 'true')
  const [accountRole, setAccountRole] = useState<{ address: Address; value: number | 'error' }>()
  const role = accountRole?.address === account ? accountRole?.value : undefined
  const roleLabel = role === 'error' ? 'โหลดบทบาทไม่สำเร็จ' : role === undefined ? 'กำลังตรวจบทบาท…' : roles[role]
  const [holderRole, setHolderRole] = useState<{ address: Address; value: number }>()
  const [manager, setManager] = useState<Address>()
  const [walletError, setWalletError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [operation, setOperation] = useState<Operation>()
  const [busy, setBusy] = useState(false)
  const [tx, setTx] = useState<{ message: string; hash?: string; error?: boolean }>()
  const [lookup, setLookup] = useState('')
  const [lookupResult, setLookupResult] = useState('')
  const roleRequest = useRef(0)

  useEffect(() => {
    const injected = provider()
    if (!live || !injected) return
    let subscribed = true
    const changed = (addresses: readonly string[]) => {
      if (!subscribed || loggedOut.current) return
      const address = addresses[0]
      setAccount(address && isAddress(address) ? getAddress(address) : undefined)
      if (address) setWalletError('')
    }
    injected.on('accountsChanged', changed)
    if (!loggedOut.current) void injected.request({ method: 'eth_accounts' }).then(changed).catch(() => {})
    return () => {
      subscribed = false
      injected.removeListener('accountsChanged', changed)
    }
  }, [])

  useEffect(() => {
    if (live) void readManager().then(setManager).catch(error => setWalletError(errorMessage(error)))
  }, [])

  useEffect(() => {
    let current = true
    if (account) void readRole(account).then(value => {
      if (current) setAccountRole({ address: account, value })
    }).catch(error => {
      if (current) {
        setAccountRole({ address: account, value: 'error' })
        setWalletError(errorMessage(error))
      }
    })
    return () => { current = false }
  }, [account])

  const proposedHolder = result?.batch.proposedHolder
  const currentHolder = result?.batch.holder
  useEffect(() => {
    setHolderRole(undefined)
    if (!account || !currentHolder || !same(account, proposedHolder)) return
    let current = true
    void readRole(currentHolder).then(value => {
      if (current) setHolderRole({ address: currentHolder, value })
    }).catch(error => {
      if (current) setWalletError(errorMessage(error))
    })
    return () => { current = false }
  }, [account, currentHolder, proposedHolder])

  async function connect() {
    setWalletError('')
    const injected = provider()
    if (!injected) {
      setWalletError('กรุณาเปิดเว็บในเบราว์เซอร์ที่มี MetaMask')
      return
    }
    setConnecting(true)
    try {
      const reselecting = loggedOut.current
      if (reselecting) {
        await injected.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] })
      }
      const [address] = await injected.request({ method: reselecting ? 'eth_accounts' : 'eth_requestAccounts' })
      if (!address) throw new Error('กรุณาเลือกบัญชีใน MetaMask')
      const connectedAccount = getAddress(address)
      loggedOut.current = false
      sessionStorage.removeItem(walletLogoutKey)
      setAccount(connectedAccount)
    } catch (error) {
      const details = typeof error === 'object' && error !== null ? error : undefined
      const code = details && 'code' in details ? details.code : undefined
      const message = details && 'message' in details ? String(details.message) : ''
      if (code === -32002 || /already pending/i.test(message)) {
        setWalletError('MetaMask มีคำขอเชื่อมต่อค้างอยู่ เปิดส่วนขยาย MetaMask เพื่อยืนยันหรือยกเลิกคำขอเดิม')
      } else if (code === 4001) {
        setWalletError('ยกเลิกการเชื่อมต่อแล้ว กดเชื่อม MetaMask เมื่อต้องการลองใหม่')
      } else {
        setWalletError(errorMessage(error))
      }
    } finally {
      setConnecting(false)
    }
  }

  function disconnect() {
    loggedOut.current = true
    sessionStorage.setItem(walletLogoutKey, 'true')
    setAccount(undefined)
    setAccountRole(undefined)
    setOperation(undefined)
    setTx(undefined)
    setWalletError('')
  }

  async function loadPage(key: ReturnType<typeof batchKey>, count: bigint, loaded: number, version: number) {
    setLoadingHistory(true)
    setHistoryError('')
    try {
      const remaining = count - BigInt(loaded)
      const length = Number(remaining < pageSize ? remaining : pageSize)
      const page = await Promise.all(Array.from({ length }, (_, i) => readHistory(key, remaining - 1n - BigInt(i))))
      if (version === searchVersion.current) setEntries(previous => [...previous, ...page])
    } catch (error) {
      if (version === searchVersion.current) setHistoryError(errorMessage(error))
    } finally {
      if (version === searchVersion.current) setLoadingHistory(false)
    }
  }

  async function search(id: string) {
    const version = ++searchVersion.current
    setSearchError('')
    setHistoryError('')
    setLoadingHistory(false)
    setResult(null)
    setEntries([])
    if (!live) {
      if (id === sample.batchCode) {
        setResult({ id, batch: sample, count: BigInt(sampleHistory.length) })
        setEntries(sampleHistory)
      } else setSearchError('โหมดตัวอย่างใช้ Batch ID GF-2026-001')
      return
    }
    setSearching(true)
    try {
      const key = batchKey(id)
      const [batch, count] = await Promise.all([readBatch(key), readCount(key)])
      if (version !== searchVersion.current) return
      setResult({ id, batch, count })
      setSearching(false)
      await loadPage(key, count, 0, version)
    } catch (error) {
      if (version === searchVersion.current) setSearchError(errorMessage(error))
    } finally {
      if (version === searchVersion.current) setSearching(false)
    }
  }

  async function checkRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const request = ++roleRequest.current
    const address = lookup.trim()
    if (!isAddress(address)) {
      setLookupResult('ที่อยู่กระเป๋าไม่ถูกต้อง')
      return
    }
    if (!live) {
      const demoRole = same(address, sampleFarmer) ? roles[1] : same(address, demoManager) ? roles[4] : roles[0]
      setLookupResult(demoRole)
      return
    }
    setLookupResult('กำลังตรวจสอบ…')
    try {
      const value = await readRole(address)
      if (request === roleRequest.current) setLookupResult(roles[value])
    } catch (error) {
      if (request === roleRequest.current) setLookupResult(errorMessage(error))
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!account || !selected || !canSubmit || busy) return
    let hash: string | undefined
    setBusy(true)
    try {
      const id = result?.id ?? ''
      const call = callFor(selected, new FormData(event.currentTarget), id)
      setTx({ message: 'กำลังตรวจสอบและรอยืนยันผ่าน MetaMask…' })
      await send(account, call, value => {
        hash = value
        setTx({ message: 'ส่งธุรกรรมแล้ว กำลังรอการยืนยัน…', hash })
      })
      setTx({ message: 'ธุรกรรมยืนยันแล้ว', hash })
      setOperation(undefined)
      if (call.functionName === 'createBatch') {
        const [newId] = call.args
        setQuery(newId)
        await search(newId)
      } else if (call.functionName === 'assignRole') {
        roleRequest.current++
        setLookupResult('')
      } else if (id) {
        await search(id)
      }
    } catch (error) {
      setTx({ message: errorMessage(error), error: true, hash })
    } finally {
      setBusy(false)
    }
  }

  const batch = result?.batch
  const supplyChainActor = typeof role === 'number' && role >= 1 && role <= 3
  const allowed: Operation[] = []
  if (live && account) {
    if (same(account, manager)) allowed.push('assignRole')
    if (role === 1) allowed.push('createBatch')
    if (batch) {
      const holder = same(account, batch.holder)
      const recipient = same(account, batch.proposedHolder)
      const pending = !same(batch.proposedHolder, zeroAddress)
      if (holder && supplyChainActor) {
        if (batch.recallState !== 1 && !pending && (role === 1 || role === 2)) allowed.push('requestTransfer')
        if (batch.recallState !== 1 && batch.status < stages.length - 1) allowed.push('updateProductStatus')
      }
      const senderRole = same(holderRole?.address, batch.holder) ? holderRole?.value : undefined
      const validRecipientRole = (senderRole === 1 && role === 2) || (senderRole === 2 && role === 3)
      if (recipient && validRecipientRole && batch.recallState !== 1) allowed.push('confirmTransfer')
      if (pending && (holder || recipient || same(account, manager))) allowed.push('cancelTransfer')
      if (same(account, manager)) allowed.push(batch.recallState === 1 ? 'closeRecall' : 'openRecall')
    }
  }

  const selected = operation
  const canSubmit = selected !== undefined && allowed.includes(selected)
  const needsBatch = selected !== 'createBatch' && selected !== 'assignRole'
  const previewMessage = !live ? 'โหมดตัวอย่าง · เปิดดูฟอร์มได้ทุกเมนู'
    : !account ? 'เชื่อม MetaMask เพื่อส่งธุรกรรม'
    : needsBatch && !batch ? 'ค้นหา Batch ID เพื่อเลือกล็อตก่อนทำรายการ'
    : 'บัญชีนี้หรือสถานะล็อตปัจจุบันยังทำรายการนี้ไม่ได้'
  const formHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (selected) formHeading.current?.focus()
  }, [selected])

  return <>
    <header className="top"><div className="frame header-inner">
      <a href="./" className="brand"><span className="mark" aria-hidden="true">✳</span><span>AgriSupplyTracker</span></a>
      <div className="connection"><span className="network"><i />{live ? 'Sepolia' : 'โหมดตัวอย่าง'}</span>
        {live && (account ? <>
          <span className="wallet-address" title={account}>{short(account)}</span>
          <span className="badge" role="status">{roleLabel}</span>
          <button type="button" className="outline" onClick={disconnect} disabled={connecting || busy}>ออกจากระบบ</button>
        </> : <button type="button" className="outline" onClick={connect} disabled={connecting || busy}>{connecting ? 'รอเลือกบัญชีใน MetaMask…' : 'เชื่อม MetaMask'}</button>)}
      </div>
    </div></header>
    <div className="frame workspace">
      <aside className="sidebar" aria-label="จัดการข้อมูล">
        <h2 className="sidebar-title">จัดการข้อมูล</h2>
        <nav className="side-menu" aria-label="ฟังก์ชันจัดการข้อมูล">
          {menuGroups.map(group => <div className="menu-group" key={group.label}>
            <h3>{group.label}</h3>
            {group.actions.map(action => <button type="button" key={action} aria-pressed={selected === action}
              disabled={busy} onClick={() => {
                setOperation(action)
                setTx(undefined)
                if (selected === action) formHeading.current?.focus()
              }}>{definitions[action].label}</button>)}
          </div>)}
        </nav>
      </aside>
      <main>
        <section className="hero">
          <div className="hero-content">
            <h1>ตรวจสอบย้อนกลับ<br />ล็อตสินค้าเกษตร</h1>
            <p>ค้นหาที่มา สถานะ และประวัติการส่งมอบด้วย Batch ID</p>
            <form className="search" onSubmit={event => { event.preventDefault(); if (query) void search(query) }}>
              <input required aria-label="Batch ID" placeholder="ระบุ Batch ID" value={query} onChange={event => setQuery(event.target.value)} />
              <button disabled={searching || busy}>{searching ? 'กำลังค้นหา…' : 'ค้นหาล็อต'}</button>
            </form>
            {searchError && <p className="search-error" role="alert">{searchError}</p>}
          </div>
          <div className="hero-lines" aria-hidden="true"><span /><span /><span /><span /><span /></div>
        </section>

        <section className="card utilities">
          <div><h2>บัญชีและสิทธิ์</h2>
            <p>{account ? `${short(account)} · ${roleLabel}` : live ? 'เชื่อม MetaMask เพื่อทำรายการตามสิทธิ์ของบัญชี' : 'ลองตรวจสิทธิ์ด้วยที่อยู่เกษตรกรในล็อตตัวอย่าง'}</p>
            {walletError && <p role="alert" className="error">{walletError}</p>}
            {(live ? manager : demoManager) && <p className="address">ผู้ดูแลหลัก <code>{live ? manager : demoManager}</code></p>}
          </div>
          <form className="lookup" onSubmit={checkRole}>
            <input aria-label="ที่อยู่กระเป๋าสำหรับตรวจสอบสิทธิ์" placeholder="ที่อยู่กระเป๋า 0x…" value={lookup} onChange={event => {
              roleRequest.current++; setLookup(event.target.value); setLookupResult('')
            }} required />
            <button className="outline">ตรวจสิทธิ์</button>
            <output>{lookupResult}</output>
          </form>
        </section>

        {(selected || tx) && <section className="card operations">
          <h2 ref={formHeading} tabIndex={-1}>{selected ? definitions[selected].label : 'สถานะธุรกรรม'}</h2>
          {selected && !canSubmit && <p className="demo-help">{previewMessage}</p>}
          {selected && <form className="operation-form" key={`${selected}:${account ?? ''}:${needsBatch ? result?.id ?? '' : ''}`} onSubmit={submit}>
            <fieldset disabled={busy}>
              <legend>{definitions[selected].label}{needsBatch && result && ` · ${result.id}`}</legend>
              {definitions[selected].fields.map(({ name, label, type, optional, options: choices }) => <label key={name}>{label}
                {choices ? <select name={name} required defaultValue="">
                  <option value="" disabled>เลือก{label}</option>
                  {choices.filter(choice => name !== 'stage' || !canSubmit || choice.value === (batch?.status ?? 0) + 1)
                    .map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                </select> : type === 'textarea' ? <textarea name={name} required={!optional} /> : <input name={name} type={type ?? 'text'} required={!optional} />}
              </label>)}
              {selected === 'requestTransfer' && <p>ส่งมอบจากเกษตรกรไปยังผู้ขนส่ง หรือจากผู้ขนส่งไปยังผู้จัดจำหน่าย</p>}
              {definitions[selected].fields.length === 0 && <p>รายการนี้ใช้ Batch ID ของล็อตที่เปิดอยู่</p>}
              {canSubmit && <button>{busy ? 'กำลังดำเนินการ…' : 'ยืนยันผ่าน MetaMask'}</button>}
            </fieldset>
          </form>}
          {tx && <p className={tx.error ? 'error' : 'tx'} role={tx.error ? 'alert' : 'status'}>{tx.message}
            {tx.hash && <> · <a href={`${explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">ดูธุรกรรม</a></>}
          </p>}
        </section>}

        {result && <div className="results">
          <section className="card details">
            <div className="card-heading"><div><p className="batch-id">BATCH ID · {result.batch.batchCode}</p><h2>{result.batch.name}</h2></div>
              <span className={result.batch.recallState === 1 ? 'badge danger' : 'badge'}>{result.batch.recallState === 1 ? 'อยู่ระหว่างเรียกคืน' : stages[result.batch.status]}</span>
            </div>
            {result.batch.recallState === 1 && <p className="error">{result.batch.recallNote}</p>}
            {result.batch.recallState === 2 && <p>ปิดการเรียกคืนแล้ว · {result.batch.recallNote}</p>}
            <ol className="stages">{stages.map((stage, index) => <li key={stage} aria-current={index === result.batch.status ? 'step' : undefined}
              className={index <= result.batch.status ? 'reached' : ''}><span>{index < result.batch.status ? '✓' : index + 1}</span>{stage}</li>)}</ol>
            <dl className="metadata"><div><dt>แหล่งผลิต</dt><dd>{result.batch.farmLocation}</dd></div>
              <div><dt>เวลาเก็บเกี่ยว</dt><dd>{date(result.batch.harvestDate)}</dd></div>
              <div><dt>ใบรับรอง</dt><dd>{result.batch.certificate}</dd></div>
              <div><dt>เกษตรกร</dt><dd><code>{result.batch.producer}</code></dd></div>
              <div><dt>ผู้ครอบครองปัจจุบัน</dt><dd><code>{result.batch.holder}</code></dd></div>
              {!same(result.batch.proposedHolder, zeroAddress) && <div><dt>รอรับมอบโดย</dt><dd><code>{result.batch.proposedHolder}</code></dd></div>}
            </dl>
          </section>
          <section className="card history">
            <div className="card-heading"><h2>ประวัติล็อต</h2><span className="count">{String(result.count)} รายการ</span></div>
            <ol className="timeline">{entries.map((entry, index) => <li key={index}>
              <time>{date(entry.recordedAt)}</time>
              <h3>{events[entry.activity]}</h3>
              {entry.details && <p>{entry.details}</p>}
              <p className="history-meta">{stages[entry.status]} · ผู้ทำรายการ <code title={entry.performedBy}>{short(entry.performedBy)}</code>
                {!same(entry.from, zeroAddress) && <> · จาก <code title={entry.from}>{short(entry.from)}</code></>}
                {!same(entry.to, zeroAddress) && <> · ถึง <code title={entry.to}>{short(entry.to)}</code></>}
              </p>
            </li>)}</ol>
            {historyError && <p role="alert" className="error">{historyError}</p>}
            {BigInt(entries.length) < result.count && <button className="outline" disabled={loadingHistory} onClick={() => void loadPage(batchKey(result.id), result.count, entries.length, searchVersion.current)}>
              {loadingHistory ? 'กำลังโหลด…' : historyError ? 'ลองโหลดอีกครั้ง' : 'โหลดประวัติเพิ่ม'}
            </button>}
          </section>
        </div>}
      </main>
    </div>
    <footer className="frame">AgriSupplyTracker <span>{live ? 'Ethereum Sepolia' : 'ข้อมูลตัวอย่าง'}</span></footer>
  </>
}

createRoot(document.getElementById('root')!).render(<App />)
