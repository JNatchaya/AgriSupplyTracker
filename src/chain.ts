import { createPublicClient, createWalletClient, custom, http, isAddress, keccak256, parseAbi, stringToHex, BaseError, ContractFunctionRevertedError, type Address, type ContractFunctionName, type ContractFunctionArgs, type EIP1193Provider } from 'viem'
import { sepolia } from 'viem/chains'

export const abi = parseAbi([
  'struct Product { string batchCode; string name; string farmLocation; string certificate; uint64 harvestDate; address producer; address holder; address proposedHolder; uint8 status; uint8 recallState; string recallNote; }',
  'struct TrackingRecord { uint8 activity; uint64 recordedAt; address performedBy; address from; address to; uint8 status; string details; }',
  'function manager() view returns (address)',
  'function memberRoles(address member) view returns (uint8)',
  'function getProduct(bytes32 key) view returns (Product)',
  'function getRecordCount(bytes32 key) view returns (uint256)',
  'function getRecord(bytes32 key, uint256 index) view returns (TrackingRecord)',
  'function assignRole(address member, uint8 role)',
  'function createBatch(string batchCode, string name, uint64 harvestDate, string farmLocation, string certificate)',
  'function requestTransfer(bytes32 key, address nextHolder)',
  'function confirmTransfer(bytes32 key)',
  'function cancelTransfer(bytes32 key)',
  'function updateProductStatus(bytes32 key, uint8 newStatus, string details)',
  'function openRecall(bytes32 key, string reason)',
  'function closeRecall(bytes32 key, string resolution)',
])

const configuredAddress = import.meta.env.VITE_CONTRACT_ADDRESS?.trim() ?? ''
const apiKey = import.meta.env.VITE_INFURA_API_KEY?.trim() ?? ''
export const live = isAddress(configuredAddress)
const client = createPublicClient({
  chain: sepolia,
  transport: http(apiKey ? `https://sepolia.infura.io/v3/${apiKey}` : 'https://ethereum-sepolia-rpc.publicnode.com'),
})
const contract = { abi, address: configuredAddress as Address }
export const explorer = sepolia.blockExplorers.default.url

type BrowserWallet = EIP1193Provider & {
  removeListener: EIP1193Provider['removeListener']
}

export function provider() {
  return (window as Window & { ethereum?: BrowserWallet }).ethereum
}

export const batchKey = (code: string) => keccak256(stringToHex(code))

export const readBatch = (key: ReturnType<typeof batchKey>) => client.readContract({ ...contract, functionName: 'getProduct', args: [key] })
export const readCount = (key: ReturnType<typeof batchKey>) => client.readContract({ ...contract, functionName: 'getRecordCount', args: [key] })
export const readHistory = (key: ReturnType<typeof batchKey>, index: bigint) => client.readContract({ ...contract, functionName: 'getRecord', args: [key, index] })
export const readRole = (account: Address) => client.readContract({ ...contract, functionName: 'memberRoles', args: [account] })
export const readManager = () => client.readContract({ ...contract, functionName: 'manager' })

export type Batch = Awaited<ReturnType<typeof readBatch>>
export type Entry = Awaited<ReturnType<typeof readHistory>>
type WriteName = ContractFunctionName<typeof abi, 'nonpayable'>
export type ActionCall = {
  [Name in WriteName]: {
    functionName: Name
    args: ContractFunctionArgs<typeof abi, 'nonpayable', Name>
  }
}[WriteName]

export async function send(account: Address, call: ActionCall, onSubmitted: (hash: string) => void) {
  const injected = provider()
  if (!live || !injected) throw new Error('กรุณาตั้งค่า Sepolia และเชื่อม MetaMask')
  const wallet = createWalletClient({ chain: sepolia, transport: custom(injected) })
  const chainId = await wallet.getChainId()
  if (chainId !== sepolia.id) {
    try {
      await wallet.switchChain({ id: sepolia.id })
    } catch (error) {
      if (!(error instanceof BaseError) || !error.walk(cause => typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 4902)) throw error
      // Only prompt for an unknown chain, and use the chain's public RPC here.
      await wallet.addChain({ chain: sepolia })
      await wallet.switchChain({ id: sepolia.id })
    }
  }
  const parameters = { ...contract, ...call, account }
  await client.simulateContract<typeof abi, WriteName, ActionCall['args'], undefined, Address>(parameters)
  const hash = await wallet.writeContract<typeof abi, WriteName, ActionCall['args']>(parameters)
  onSubmitted(hash)
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('ธุรกรรมถูกย้อนกลับบนบล็อกเชน')
}

export function errorMessage(error: unknown) {
  if (error instanceof BaseError) {
    const revert = error.walk(cause => cause instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError && revert.reason === 'Unknown batch') return 'ไม่พบ Batch ID นี้บนบล็อกเชน'
    return revert instanceof ContractFunctionRevertedError && revert.reason ? revert.reason : error.shortMessage
  }
  return error instanceof Error ? error.message : 'เกิดข้อผิดพลาด กรุณาลองอีกครั้ง'
}
