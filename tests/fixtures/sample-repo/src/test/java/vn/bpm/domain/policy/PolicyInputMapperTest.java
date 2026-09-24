package vn.bpm.domain.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import org.junit.jupiter.api.Test;
import vn.bpm.domain.fact.LoanFact;

/** Test cho PolicyInputMapper (fixture). */
public class PolicyInputMapperTest {

    @Test
    public void mapsPurposeOfLoan() {
        LoanFact fact = new LoanFact();
        PolicyInputMapper mapper = new PolicyInputMapper();
        PolicyInput input = mapper.map(fact);
        assertEquals(null, input.getPurposeOfLoan());
    }
}
