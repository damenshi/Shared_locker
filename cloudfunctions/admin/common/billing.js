// 计费算法：返回{rent:应收, deposit:押金}
function computeFee(startTime, endTime, rule){
  const ms = Math.max(0, endTime - startTime)
  const minutes = Math.ceil(ms / 60000)
  // free time
  if (minutes <= (rule.freeMinutes||0)) {
    return { rent: 0, deposit: rule.depositPrice||0 }
  }
  let cost = 0
  const mAfterFree = minutes - (rule.freeMinutes||0)
  // first use
  if (mAfterFree > 0) {
    const fpMin = rule.firstPeriodMinutes || 0
    if (mAfterFree <= fpMin) {
      cost = rule.firstPeriodPrice || 0
    } else {
      cost = rule.firstPeriodPrice || 0
      const remain = mAfterFree - fpMin
      const unit = rule.unitMinutes || 30
      const units = Math.ceil(remain / unit)
      cost += units * (rule.unitPrice || 0)
    }
  }
  if (rule.capPrice) cost = Math.min(cost, rule.capPrice)
  return { rent: cost, deposit: rule.depositPrice||0 }
}

module.exports = { computeFee }
