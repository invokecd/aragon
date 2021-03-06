import { Company } from './deployed'
import { StockSale, IndividualInvestorSale, BoundedStandardSale } from './contracts'

import { dispatcher, actions } from '/client/lib/action-dispatcher'
import TxQueue from '/client/lib/queue'
import { verifyContractCode } from './verify'

import Watcher from './watcher'

class StockSalesWatcher extends Watcher {
  constructor() {
    super('ss')
    this.setupCollections()
  }

  listen() {
    this.listenForNewSales()
    this.listenForSalesEvents()
  }

  setupCollections() {
    this.StockSales = new Mongo.Collection('sales', { connection: null })
    this.persistentStockSales = new PersistentMinimongo(this.StockSales)
  }

  listenForNewSales() {
    this.watchEvent(Company().NewStockSale, async (err, ev) => {
      const newsale = await this.getSale(ev.args.saleAddress, ev.args.saleIndex.toNumber())
      this.listenForSalesEvents([newsale])
    })
  }

  listenForSalesEvents(sales = this.StockSales.find().fetch()) {
    const update = sale => ((err, a) => {
      if (a.length === 0) { return } // Discard empty get arrays
      const ev = a[a.length - 1] || a

      this.getSale(sale.address, sale.index)
    })

    sales.forEach(sale => {
      const stockSale = StockSale.at(sale.address)
      this.watchEvent(stockSale.StockSold, update(sale))
      this.watchEvent(stockSale.StockBought, update(sale))
    })
  }

  async getSale(address, index) {
    const sale = StockSale.at(address)
    const investorAddresses = _.range(0, await sale.investorIndex.call())
                                .map(i => sale.investors.call(i))
    const investors = Promise.all(investorAddresses)
                      .then(x => [...new Set(x)].map(a => Promise.allProperties({ address: a, tokens: sale.buyers.call(a).then(x => x.toNumber()) })))

    const verifiedSale = await this.verifySale(address)

    if (!verifiedSale) {
      return console.error('Unknown sale')
    }

    const saleObject = {
      stock: sale.stockId.call().then(x => x.toNumber()),
      closeDate: sale.closeDate.call().then(x => new Date(x.toNumber() * 1000)),
      raisedAmount: sale.raisedAmount.call().then(x => x.toNumber()),
      title: sale.saleTitle.call(),
      type: verifiedSale.contractClass.contract_name,
      raiseTarget: sale.raiseTarget.call().then(x => x.toNumber()),
      raiseMaximum: sale.raiseMaximum.call().then(x => x.toNumber()),
      buyingPrice: sale.getBuyingPrice.call(0).then(x => x.toNumber()),
      availableTokens: sale.availableTokens.call().then(x => x.toNumber()),
      investors: Promise.all(await investors), // unique elements in array
      typeMetadata: verifiedSale.additionalProperties(address),
      index,
      address,
    }

    const finalSale = await Promise.allProperties(saleObject)
    console.log(finalSale)

    this.StockSales.upsert(`ss_${address}`, finalSale)
    return finalSale
  }

  async verifySale(address) {
    const allClasses = this.allSales.map(s => s.contractClass)
    const verifiedContract = await verifyContractCode(address, allClasses)

    if (!verifiedContract) { return null }
    return this.allSales.filter(x => x.contractClass === verifiedContract)[0]
  }

  async createIndividualInvestorSale(stock, investor, price, units, closes, title = 'Series Y') {
    const saleTx = await dispatcher.deployContract(IndividualInvestorSale,
                          Company().address, stock, investor, units, price, closes, title)
    return this.watchSaleDeployTransaction(saleTx)
  }

  async createBoundedSale(stock, min, max, price, closes, title = 'Series Z') {
    const saleTx = await dispatcher.deployContract(BoundedStandardSale,
                         Company().address, stock, min, max, price, closes, title)
    return this.watchSaleDeployTransaction(saleTx)
  }

  watchSaleDeployTransaction(txId) {
    TxQueue.addListener(txId, () => {
      web3.eth.getTransactionReceipt(txId, (err, tx) => {
        if (err) return console.error(err)
        if (!tx.contractAddress) return console.error('error deploying sale', tx)
        return this.submitSale(StockSale.at(tx.contractAddress), txId)
      })
    })
  }

  async submitSale(sale, txId) {
    console.log('submitting sale', sale)
    // Megahack
    dispatcher.dontHideMetamask = true
    await dispatcher.performTransaction(sale.setTxid, txId)
    dispatcher.dontHideMetamask = false
    return dispatcher.dispatch(actions.beginSale, sale.address)
  }

  get allSales() {
    return [
      {
        contractClass: IndividualInvestorSale,
        additionalProperties: async a => {
          const c = IndividualInvestorSale.at(a)
          const investorAddress = c.investor.call()
          return await Promise.allProperties({ investorAddress })
        },
      },
      {
        contractClass: BoundedStandardSale,
        additionalProperties: () => ({}),
      },
    ]
  }
}

export default new StockSalesWatcher()
