package vn.bpm.domain.fact;

/** Fact khoản vay (fixture). */
public class LoanFact {

    private String purposeOfLoan;
    private String collateralType;
    private long loanAmount;

    public String getPurposeOfLoan() {
        return purposeOfLoan;
    }

    public String getCollateralType() {
        return collateralType;
    }

    public long getLoanAmount() {
        return loanAmount;
    }
}
